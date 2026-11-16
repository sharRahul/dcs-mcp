# DCS-MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Digital Combat Simulator (DCS World)**. Works with any MCP client — Claude, Codex, OpenCode, etc. — over stdio.

What it does:

- **Build missions offline** — create a `.miz` and add groups, SAM sites, static objects, zones, triggers, scripts, weather, briefing and mission options. Aircraft can start in the air, on a runway, from parking (cold or hot) or from a carrier. Saves are copy-on-write. No running DCS needed.
- **Edit existing missions** — remove, rename, move and update groups, units, waypoints, zones and triggers, with references checked so a trigger never silently goes dead.
- **Know the game's data offline** — exact unit type ids, all 92 countries, every airfield with its parking on 12 theatres, and lat/lon ↔ DCS x/y conversion without DCS.
- **Inspect missions** — open a `.miz`, read its summary, groups, triggers, zones, weather and briefing, and validate it.
- **Live control** — query units, spawn groups, send messages, check terrain, and load a mission into a *running* DCS via a bundled hook.
- **Diagnose** — read `dcs.log` for the errors that appear nowhere else, including with DCS closed.

It never executes mission Lua (missions are parsed as data), never overwrites a source `.miz`, and keeps raw-Lua execution behind an explicit opt-in.

## Install

Node 18 or newer. The server runs straight from npm:

```bash
npx -y dcs-mcp-server --version
```

Or from a clone:

```bash
npm install && npm run build   # outputs dist/index.js
npm test                       # optional
```

## Client configuration

Point your MCP client at the server (stdio):

```json
{
  "mcpServers": {
    "dcs": { "command": "npx", "args": ["-y", "dcs-mcp-server"] }
  }
}
```

From a clone, use `"command": "node", "args": ["/absolute/path/to/dcs-mcp/dist/index.js"]` instead.

- **Claude Code**: `claude mcp add dcs -- npx -y dcs-mcp-server`. The repo's own [`.mcp.json`](.mcp.json) runs `node dist/index.js` with a *relative* path, which only works when the client starts the server from the repository root — Claude Code does, for project-scoped servers. Build first.
- **Claude Desktop**: add the block above to `claude_desktop_config.json`.
- **Codex**: add an equivalent `command`/`args` entry in `~/.codex/config.toml`.
- **OpenCode**: add it under `mcp` in `opencode.json`.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DCS_BRIDGE_HOST` / `DCS_BRIDGE_PORT` | `127.0.0.1` / `8899` | Where the live hook listens |
| `DCS_SAVED_GAMES` | `Saved Games/DCS` (then `DCS.openbeta`) | DCS profile folder for the log, frameworks, mods and hook installer |
| `DCS_INSTALL_DIR` | `Program Files/Eagle Dynamics/DCS World*` | DCS install, scanned for unit mods |
| `DCS_MCP_STATE_DIR` | `<tmp>/dcs-mcp-sessions` | Session snapshots; `off` disables them |
| `DCS_ALLOW_RAW_LUA` | unset | `1` exposes `dcs_execute_lua` (also needs `ALLOW_EXEC` in the hook) |

The server sends MCP `instructions` with the conventions that matter most (axes, headings, exact type ids), serves the full guide as the resource `dcs://guide/conventions`, and offers three prompts: `build_mission`, `diagnose_mission` and `fly_mission`.

## Tools

**Author (offline):** `dcs_miz_new`, `dcs_miz_add_aircraft_group`, `dcs_miz_add_ground_group`, `dcs_miz_add_static`, `dcs_miz_add_waypoint`, `dcs_miz_set_payload`, `dcs_miz_set_group_task`, `dcs_miz_add_trigger_zone`, `dcs_miz_add_trigger`, `dcs_miz_load_scripts`, `dcs_miz_list_resources`, `dcs_miz_set_weather`, `dcs_miz_set_briefing`, `dcs_miz_set_mission_options`, `dcs_miz_diff`, `dcs_miz_save_as`

**Scene building (offline):** `dcs_miz_add_farp`, `dcs_miz_populate_airfield`, `dcs_miz_add_target_area`, `dcs_miz_add_naval_group`, `dcs_list_scene_templates`

**Edit (offline):** `dcs_miz_remove_group`, `dcs_miz_remove_unit`, `dcs_miz_remove_zone`, `dcs_miz_remove_trigger`, `dcs_miz_remove_waypoint`, `dcs_miz_rename_group`, `dcs_miz_rename_unit`, `dcs_miz_move_group`, `dcs_miz_move_unit`, `dcs_miz_update_group`, `dcs_miz_update_waypoint`, `dcs_miz_update_zone`, `dcs_miz_update_trigger`

**Inspect (offline):** `dcs_miz_open`, `dcs_miz_get_summary`, `dcs_miz_list_groups`, `dcs_miz_list_triggers`, `dcs_miz_list_zones`, `dcs_miz_get_weather`, `dcs_miz_get_briefing`, `dcs_miz_validate`, `dcs_miz_list_sessions`, `dcs_miz_restore_session`, `dcs_miz_close`

**Reference (offline):** `dcs_list_unit_types`, `dcs_list_countries`, `dcs_country_inventory`, `dcs_list_installed_mods`, `dcs_list_airfields`, `dcs_list_site_templates`, `dcs_geo_convert`

**Live (DCS running):** `dcs_bridge_status`, `dcs_get_self_data`, `dcs_get_mission_info`, `dcs_get_all_units`, `dcs_get_aircraft_list`, `dcs_send_message`, `dcs_spawn_unit`, `dcs_convert_coords`, `dcs_check_terrain`, `dcs_load_mission`, and (gated) `dcs_execute_lua`

**Setup & diagnostics (work with DCS closed):** `dcs_install_hook`, `dcs_status`, `dcs_get_log_errors`

Every placement takes either DCS `x`/`y` metres (x = north, y = east) or `lat`/`lon`, converted offline.

Every tool declares an `outputSchema` and returns `structuredContent` alongside its text, so clients get typed results rather than prose they have to re-parse. Tools that read data also take `response_format` (`markdown` or `json`).

### Guardrails worth knowing

- `dcs_miz_save_as` refuses to write over the source `.miz`, and refuses to replace **any** existing file unless you pass `overwrite=true`.
- `dcs_miz_validate` (also run automatically before every save) reports duplicate names, empty groups, implausible QNH, triggers referencing a group, unit or zone the mission does not contain, invalid flags, groups with no route points (which the Mission Editor cannot open), and triggers with no compiled runtime entry (which would not fire if flown).
- Removing a group, unit or zone that a trigger references is refused unless you pass `force=true`, and the result names the triggers left dangling. Removing a trigger renumbers and recompiles the ones after it, and is refused if a later trigger uses a predicate this server cannot recompile.
- Renames refuse names already in use and list the scripts that still mention the old name (Skynet prefixes, MOOSE lookups, inline `do_script`); Lua is never rewritten.
- Sessions are snapshotted to disk after every change (`DCS_MCP_STATE_DIR`). After a server or client restart the same `sessionId` keeps working; `dcs_miz_list_sessions` also lists restorable snapshots. Closing a session discards unsaved changes and deletes its snapshot. Snapshots older than 14 days are pruned.

## Using it from Claude / Codex / OpenCode

Once configured, just ask your AI client in natural language — it calls the tools for you. All tools are available at once; the model uses `dcs_bridge_status` to decide whether to work live or offline.

**Build a mission offline (no DCS needed):**

> "Create a Caucasus mission, add a 2-ship F/A-18C CAP flight for the USA with two waypoints, set clear weather and a briefing, then save it to ~/Missions/op.miz"

→ `dcs_miz_new` → `dcs_miz_add_aircraft_group` → `dcs_miz_add_waypoint` → `dcs_miz_set_group_task` → `dcs_miz_set_weather` → `dcs_miz_set_briefing` → `dcs_miz_save_as`

**Cold-start players at an airfield, defended by a real SAM site:**

> "On Caucasus, put two Client F-16s cold on the ramp at Kutaisi and an SA-11 at 42.25N 42.70E facing west."

→ `dcs_list_unit_types` → `dcs_miz_add_aircraft_group` (`start: parking_cold, airfield: Kutaisi`) → `dcs_list_site_templates` → `dcs_miz_add_ground_group` (`site: SA-11`, `lat`/`lon`)

**Edit a mission someone else made:**

> "Open op.miz, move the SA-6 5 km north, delete the spare tanker, and turn off external views."

→ `dcs_miz_open` → `dcs_miz_list_groups` → `dcs_miz_move_group` → `dcs_miz_remove_group` (refused, with the reason, if a trigger still uses it) → `dcs_miz_set_mission_options` → `dcs_miz_save_as`

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

Install the hook, then **restart DCS** — hooks are read at startup:

```bash
npx dcs-mcp-server install-hook                  # finds Saved Games/DCS (or DCS.openbeta)
npx dcs-mcp-server install-hook --saved-games "C:\Users\me\Saved Games\DCS.openbeta" --telemetry
```

or ask your client to run `dcs_install_hook`. It creates `Scripts/Hooks` if needed, says `unchanged` when the installed copy is current, and leaves a copy that differs (an older release, or your `ALLOW_EXEC` edit) alone unless you pass `--force` / `overwrite=true` — the old file is kept as a `.bak`. `--telemetry` also copies the in-mission telemetry script to `Scripts/`. Manual install still works: copy [`scripts/Hooks/dcs-mcp-hook.lua`](scripts/Hooks/dcs-mcp-hook.lua) into `Saved Games/DCS/Scripts/Hooks/`.

Confirm in `Saved Games/DCS/Logs/dcs.log`:

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

DCS map axes are `x` = north, `y` = east. Every placement tool also takes `lat`/`lon`, converted offline;
`dcs_geo_convert` converts either way, and the live `dcs_convert_coords` asks DCS itself.

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

## Editing what is already there

The edit tools work on missions you built here and on missions saved by the Mission Editor alike. Fields they do not touch are carried through unchanged.

- **Move** a group and its formation keeps its shape: every unit and the spawn point shift together, later waypoints stay unless `moveRoute=true`, and a new heading rotates the column about the lead so it still trails its direction of travel.
- **Update** a group's skill, task, `lateActivation` (spawns only when an `activate_group` trigger fires), `hidden` and, for aircraft, `uncontrolled`.
- **Waypoint 1 is the spawn point.** It cannot be removed, because the Mission Editor cannot open a mission with a group that has no route point. It moves with the group.
- **Triggers** reference ids, so renames and moves never break them. Removal is where they break, which is why removal checks first.

## Aircraft starts, slots and payload

`dcs_miz_add_aircraft_group` takes `start`:

```jsonc
{ "kind": "parking_cold", "airfield": "Kutaisi" }            // or parking_hot; free slots chosen
{ "kind": "parking_cold", "airfield": 26, "parking": ["14", "15"] }  // exact slots
{ "kind": "runway", "airfield": "Batumi" }
{ "kind": "ship_cold", "ship": "CVN-1" }                     // carrier UNIT name; or ship_hot
```

Point types and actions are the ones the Mission Editor writes (`TakeOffParking` / "From Parking Area", `TakeOffParkingHot`, `TakeOff` / "From Runway"; a ship start links to the ship's unit id). Parking slots come from the bundled airfield data. A slot is chosen only if the aircraft's width, length and height fit and it allows the category (aeroplane or helicopter), and slots already used in the mission are skipped. `dcs_list_airfields` shows every airfield and, for one airfield, its named slots.

`skill: "Client"` makes a multiplayer slot and `"Player"` the single-player aircraft (the validator warns about more than one). New aircraft get full internal fuel and the type's chaff and flares; `dcs_miz_set_payload` changes that.

## Static objects

`dcs_miz_add_static` places buildings, fortifications, FARP equipment, cargo (with `massKg` for sling loads), wrecks (`dead`), or any aircraft, vehicle or ship as scenery. The static `category` and `shape_name` come from the catalogue. An unknown type is an error rather than an invisible object.

## FARPs, dressed airfields, ground targets and fleets

- **FARPs.** `dcs_miz_add_farp` adds a 4-pad FARP, a single helipad or an invisible FARP. Each is a heliport static with its ATC frequency, modulation and callsign, the fields pydcs writes. Helicopters start from one with `start: { kind: "farp_cold" | "farp_hot", farp: "<name>" }`; the flight links to the pad's unit id, as a carrier start does. `support: true` adds the usual dressing (ammo dump, fuel depot, command bunker, tent, windsock) plus a support-vehicle group of the same side. In DCS, rearm and refuel at a FARP come from nearby friendly support *vehicles*, not from the statics.
- **Filling an airfield.** `dcs_miz_populate_airfield` parks static aircraft, vehicles or equipment on free parking slots, taken from DCS's own airfield data. Aircraft only go on slots they fit (a KC-135 never lands on a fighter spot), and `slots: "shelters"` keeps them in hardened shelters. `dead: true` parks wrecks for a post-strike airfield. Slots used by flights are skipped, and later flights skip the statics, so nothing spawns into a parked aircraft. The data has no slot orientation, so without `heading` each object faces the airfield reference point. That is a heuristic.
- **Ground targets.** `dcs_miz_add_target_area` builds `ammo-depot`, `fuel-depot`, `command-post`, `supply-yard` or `barracks` from statics. It lays them out in a grid rotated to a heading, with each object its own static (`<name>-N`). `zone: true` adds a covering trigger zone.
- **Fleets.** `dcs_miz_add_naval_group` adds `csg` (CVN-71 with cruiser and destroyer screen), `lha-group`, `kuznetsov-group`, `red-sag` or `convoy` as one group, with each ship on its station relative to the lead. A ship's unit `<name>-1` is the carrier for deck starts. Add waypoints to get it moving.

Every type in these templates is checked against the DCS catalogue by the tests. The *layouts* (grid spacing, FARP support positions, ship stations) are this project's conventions, not copied from Mission-Editor missions, and none has been flown yet. Check land targets with `dcs_check_terrain`.

## Countries: what DCS allows, what is real, and mods

Three sources, kept apart because they answer different questions:

| Question | Tool | Source |
|---|---|---|
| What does the Mission Editor allow this country? | `dcs_list_unit_types country=…` | DCS's own per-country lists (via pydcs) in `data/countries.json` |
| What does the country actually operate? | `dcs_country_inventory` | Wikipedia equipment lists in `data/real-world-inventory.json` |
| What does *this machine* add? | `dcs_list_installed_mods` | unit mods in Saved Games and the DCS install |

DCS's lists are permissive: Russia is offered an A-10C, and every country gets the WWII warbirds. So they say what is *possible*, not what is *realistic*. The validator warns (`COUNTRY_TYPE_NOT_OFFERED`) when a unit is outside its country's list.

`dcs_country_inventory` takes each real-world type and marks it: in DCS and offered to the country; in DCS but under other countries only; available through an **installed mod**; or missing. The match is by designation family, so the Indian Air Force's Su-30MKI matches DCS's `Su-30`, which is a different variant. With a community Su-30MKI mod installed, the inventory points at the mod's type instead. Mods are found by scanning their Lua files as *text* for unit declarations (`make_flyable`, `add_aircraft` `Name`, `GT.Name`). They are never executed, so a mod that builds its type names in code can be missed. Mod types are accepted by every placement tool and by the validator.

The Wikipedia data is a dated snapshot (`generated` in the file) of English Wikipedia's lists. It can lag or lead real service status. Regenerate it with:

```bash
python3 -I scripts/gen-real-world-inventory.py data          # needs access to en.wikipedia.org
```

**Carrier air wings.** `dcs_miz_add_naval_group` with `airWing: "auto"` adds the template's wing to the lead ship's deck under the same country:

| Template | Wing |
|---|---|
| `csg` | F/A-18C ×4, F-14B ×2, E-2C, S-3B tanker, SH-60B |
| `lha-group` | AV-8B ×4, CH-53E ×2, UH-1H ×2 |
| `kuznetsov-group` | Su-33 ×4, Ka-27 ×2 |

You can also pass your own `[{ type, count, category }]`. A squadron the country is not offered is skipped and reported, never swapped for something else. Site and naval templates likewise report ship or SAM types the country is not offered.

## Mission options

`dcs_miz_set_mission_options` sets the date (validated, leap years included), the start time and the forced options. Forced options are the realism and difficulty settings that override each player's own: labels, external views, F10 view, G-effects, unlimited fuel or weapons, civil traffic and so on. Each value is type-checked against the list the Mission Editor writes. `clearForcedOptions` hands a setting back to the player.

## Offline reference data

The bundled tables in [`data/`](data/) are what make the offline tools concrete:

| File | Contents |
|---|---|
| `countries.json` | all 92 DCS countries and ids, with the unit types the Mission Editor offers each |
| `real-world-inventory.json` | what each of 35 countries really operates (Wikipedia), matched to DCS types |
| `unit-types.json` | 144 planes, 26 helicopters, 361 vehicles, 57 ships, 263 statics (with aircraft tasks, fuel, dimensions; static category and shape) |
| `theatres.json` | 12 theatres: projection constants and 771 airfields with their parking slots |

They are generated by [`scripts/gen-reference-data.py`](scripts/gen-reference-data.py) from [pydcs](https://github.com/pydcs/dcs) (LGPL-3.0), which in turn exports them from DCS. The script reads pydcs's generated files as text and imports nothing. Regenerate after a DCS update:

```bash
pip download --no-deps pydcs -d /tmp/pydcs && (cd /tmp/pydcs && unzip -q -o *.whl)
python3 -I scripts/gen-reference-data.py /tmp/pydcs data
```

Country names are resolved against the full list, so an unknown country is an error rather than silently becoming the USA (the old behaviour). A country can only be on one side, and `mission.coalitions` is kept in step. Unit types are not *required* to be in the catalogue — new modules and mods exist — but the validator warns, because a typo spawns nothing.

**Coordinates.** `dcs_geo_convert`, and the `lat`/`lon` arguments on every placement tool, use the theatre's transverse-Mercator constants and Krüger's sixth-order series. Tests pin the result to PROJ's own `tmerc` to the millimetre. They also check that real airfields land within about a kilometre of their published coordinates on five theatres. What offline conversion cannot know is whether a future DCS version moves a theatre's origin. When a placement matters, cross-check one point with the live `dcs_convert_coords`.

**SAM site templates.** `dcs_list_site_templates` / `site` on `dcs_miz_add_ground_group` give the unit mix for SA-2, SA-3, SA-6, SA-8, SA-10, SA-11, SA-15, Hawk, Patriot, NASAMS and two EWRs. Each template carries its provenance:

| Provenance | Meaning | Templates |
|---|---|---|
| `engaged` | built this way, fought and destroyed in a live sortie | SA-2 |
| `me-saved` | copied from a Mission-Editor mission, then flown and registered with Skynet | SA-6 |
| `loaded` | flown and registered with Skynet, never engaged | SA-8, EWR-55G6, EWR-1L13 |
| `catalogue` | every type exists in DCS and the mix is the system's standard battery, but not yet flown or ME-verified here | the rest |

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

A second sortie and two more (same day, flown from the DCS mission list, player F-16 SEAD against the SA-2) verified the condition-driven triggers live: `part_of_coalition_in_zone` on a `change` trigger fired once on the false→true edge (the only live proof of the `trig.flag` latch), `unit_in_zone` on a `once` trigger fired on entering the SA-2 ring, and `group_dead` fired with its flag, message and self-disarm all running. Note that `c_group_dead` fires about a second after the last *launcher* dies, before every radar has reported `S_EVENT_DEAD`, so do not predict it from the event stream.

Still honestly unverified:

- Brand-new missions from `dcs_miz_new` are a best-effort skeleton.
- Triggers `T8-Sa6Down` (the SA-6 was never engaged), the flag-ANDed win trigger, `end_mission`, and the F10 radio-menu handler, which needs someone to press the item.
- `dcs_spawn_unit` and `dcs_send_message` are written against the DCS scripting API and, unlike the read paths, have not been exercised in a live mission since the thread-routing fix.
- New in 0.2.0 and checked offline only (serialize → reparse round trips, the validator, PROJ cross-checks), but not yet opened in the Mission Editor or flown: airfield/carrier/FARP starts and parking-slot choice, static objects, FARPs, parked-static airfields, target areas, naval formations, forced options, the `catalogue` SAM templates, and trigger removal on missions saved by the Mission Editor. The record formats follow pydcs, whose missions DCS loads, but this project's rule is that nothing counts as verified until DCS has run it.

## License

[Apache 2.0](LICENSE).
