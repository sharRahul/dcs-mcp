/**
 * What an MCP client needs to know to use these tools well.
 *
 * Clients never see this repository's CLAUDE.md — only the server
 * `instructions`, tool descriptions and resources. The hard-won conventions
 * therefore live here, served both as the server instructions (short) and as
 * the `dcs://guide/conventions` resource (complete).
 */

export const SERVER_INSTRUCTIONS = `DCS World mission authoring (offline .miz) and live control of a running sim.

Mission production: for a complete playable mission or a revision with flight evidence, read dcs://skills/mission-production (built-in skill) and dcs://skills/mission-production/contracts. The produce_mission prompt and dcs_production_create/generate/revise/validate/capture/status tools preserve immutable revisions and correlate evidence to exact saved bytes. New revisions never inherit old flight passes. The dcs_authoring_coverage_audit tool reports remaining evidence gaps; caller-supplied numeric coverage profiles are read-only evidence, not authoring defaults.

Workflow: dcs_bridge_status first to decide live vs offline. Offline: dcs_miz_new or dcs_miz_open -> dcs_miz_* edits -> dcs_miz_validate -> dcs_miz_save_as (always a NEW file). Live: check bridge phase is "running" before any mission-environment tool or dcs_load_mission; afterwards read dcs_get_log_errors, the only channel that reports a mission that failed to load.

High-level authoring: dcs_scenario_validate/generate accept a client-supplied structured specification; optional seed is deterministic. dcs_campaign_generate produces mission sessions plus a transition manifest, not a .cmp. dcs_miz_direct_mission compiles condition/dependency/world-event driven radio scripts and shot plans; missing audio means subtitles/placeholders, never playable radio. Built-in dialogue is fictional, not authenticated procedure. See dcs_miz_trigger_capabilities for the exact supported compiler surface. dcs_miz_mission_report recomputes current state after edits.

Advanced tools: dcs_list_flight_roles -> dcs_miz_create_flight/configure_flight/add_waypoint_task; dcs_miz_create_ground_plan; dcs_miz_configure_iads; dcs_miz_list_warehouses/edit_warehouse. New capabilities are offline-tested, not DCS-verified. dcs_terrain_analyze and dcs_miz_move_ground_on_terrain need an explicit sourced elevation grid, an installed terrain pack (dcs_terrain_build_pack samples DCS's own terrain once while a mission runs) or source=live with the matching running theatre; no bundled elevation data or flat fallback. Sensor visibility is sampled geometry, not radar detection.

Your DCS install is read as data where it helps: dcs_install_report gives the build, the installed terrains and where they outrun the bundled (pydcs) catalogue; dcs_theatre_data reads ED's own radio.lua/beacons.lua for ATC frequencies and TACAN/ILS/VOR/NDB on ANY installed terrain, including ones pydcs never had (Iraq, Marianas WWII). Those terrains still have no airfield ids, coordinates or parking until you sample them from a running mission with dcs_airbase_build_pack; a sampled slot's size and category flags are unknown, so parking choice stops checking fit for it.

Live-only terrain helpers (need a mission running): dcs_terrain_roads snaps points to DCS's road or railway graph (or routes along it), dcs_terrain_clear_spot finds flat land clear of scenery objects, dcs_terrain_visibility is DCS's own terrain intersection — geometry, never a sensor model. There is no offline equivalent of any of them.

Mission audio: dcs_audio_convert converts a local MP3/WAV/OGG to PCM16 WAV or Vorbis OGG (FFmpeg on PATH or DCS_FFMPEG_PATH). Pass outputPath as file to dcs_miz_add_trigger actions sound, sound_to_unit (unit name), sound_to_group (group name), sound_to_coalition (coalition), or radio_transmission. Files embed in the saved .miz; no runtime API access is needed. Unit sound is native and ME-oracle-backed; playback in multiplayer still needs a flight check.

Conventions that are easy to get wrong:
- Map axes: x = NORTH metres, y = EAST metres. Generic placement tools also accept lat/lon and convert offline. Terrain grids, candidates, advanced tasks and orbits use DCS x/y metres.
- Headings are DEGREES in this API (stored as radians in the file).
- Unit types are exact DCS type ids ('FA-18C_hornet', 'Kub 1S91 str'); look them up with dcs_list_unit_types, never guess. It also lists unit mods installed on this machine (dcs_list_installed_mods).
- For a realistic order of battle use dcs_country_inventory (what the country really operates, from Wikipedia, vs what DCS or an installed mod can place). dcs_list_unit_types country=X is only what the Mission Editor allows.
- A SAM site is one group of mixed types (radar + launchers): use composition or site templates (dcs_list_site_templates).
- FARPs, parked statics on airfields, static target areas and naval formations have their own tools (dcs_list_scene_templates).
- Triggers reference names in this API; unknown names are errors. Order-dependent script loads belong in ONE start trigger (dcs_miz_load_scripts does this).
- Never trust a ground coordinate you did not check: dcs_check_terrain (live) says land or water.
- A flight only spawns at an airfield its side owns, or at a ship/FARP that has a warehouse entry. Adding an airfield/ship/FARP start claims a neutral airfield for the flight's side and creates a missing ship/FARP entry; an enemy-owned airfield is reported, never flipped (dcs_miz_set_airbase_coalition).
- Removing something a trigger references is refused unless force=true (the trigger would never fire).
- Validation severity is calibrated against 3023 Mission-Editor-saved missions, every mission DCS itself ships among them, which report zero ERRORs: an ERROR means DCS or the editor cannot handle the file. Things the editor itself saves — duplicate unit names and unit ids, dangling trigger/task/goal/waypoint ids, two aircraft on one parking spot, countermeasure counts above the pydcs catalogue — are WARNINGS. Read them; do not treat them as a broken mission.
- Reactive missions: late-activated reserves plus a trigger that activates them (dcs_miz_add_reactive_spawn) is how this is done and is oracle-backed. Conditions can be ORed with a { kind: 'or' } separator. ED's Dynamic Slots flag (dcs_miz_set_dynamic_spawn) is written as the boolean it is and nothing more is claimed for it.
- Campaigns: dcs_campaign_read/write/step handle a real DCS .cmp. Stages are a score ladder (above 50 advances, 50 repeats, below 50 retreats) and DCS picks at random among the next stage's missions whose interval contains the score, so every stage must cover 0-100. Put the .cmp beside its missions; they are never copied.
- Imported compounds: dcs_scan_scene_candidates / dcs_import_scene_template / dcs_miz_add_scene reuse a real static footprint from a mission the user supplies, with each object's own offset and heading. Provenance 'imported': measured, not flown.\n- Unit types come from three sources, in this order: the pinned pydcs catalogue, mods on this machine (dcs_list_installed_mods), and types LEARNED from the user's own missions (dcs_learn_mission_types, dcs_list_learned_types). The catalogue always wins. A learned type proves only that the id exists and which category DCS files it under: it has no maximum fuel, no parking footprint and no task list, so no payload fuel is written for it and parking fit is not checked. Its stores are the CLSIDs it was actually flown with, which is the only weapon list a mod's mission can give. Use it for DCS types newer than the pin (Oil rig, the carrier deck crew, FARP_SINGLE_01), mods whose ids live in compiled Lua, and mods a mission names that are not installed here.\n- dcs_miz_add_farp takes a type argument for a heliport static the catalogue does not list (FARP_SINGLE_01, a mod pad), once a learned or mod source knows it.\n- Mods come in two kinds and the difference decides whether a mission loads. DEPLOYED mods sit in a Mods/ folder DCS loads, so their types spawn. AVAILABLE mods were found in a mod-manager repository (OvGME and the like, beside the DCS profile): the ids are real but DCS will not spawn them until the user enables the mod. dcs_list_installed_mods reports both with a deployed flag, and a deployed mod always wins the same id.\n- So an unknown type has four different answers, and the validator distinguishes them: nothing (catalogued, or a mod DCS loads), MOD_NOT_DEPLOYED (a mod in a repository), TYPE_NOT_ON_THIS_MACHINE (learned from a mission, nothing here declares it), and UNKNOWN_UNIT_TYPE (nothing knows it - likely a typo). All warnings: the file is valid in every case, but only the first will actually spawn here.\n- Any theatre can hold a mission and units; what needs bundled data is airfield lookup and lat/lon conversion. For an installed theatre pydcs never exported, sample its airbases once from a running mission with dcs_airbase_build_pack.\n- A troop lift's unload task is Disembarking. DCS refuses Hoggit's DisembarkFromTransport outright, which was found by loading a mission and reading dcs.log, so do not go back to it.
- Sessions are snapshotted to disk; after a server restart use dcs_miz_list_sessions and dcs_miz_restore_session.

Full reference: resource dcs://guide/conventions.`;

export const CONVENTIONS_GUIDE = `# DCS-MCP conventions

## Coordinates
- DCS map coordinates are metres on a per-theatre transverse-Mercator grid. **x is NORTH, y is EAST.**
- Tools that place things accept either \`x\`/\`y\` or \`lat\`/\`lon\`. lat/lon is converted offline using the
  theatre's projection constants (from pydcs, which exports them from DCS). For a mission that matters,
  cross-check one point live with \`dcs_convert_coords\`.
- \`dcs_geo_convert\` converts in either direction offline, for any supported theatre.

## Headings and layout
- Headings are degrees, clockwise from north. The file stores radians; conversion is automatic.
- A group's units trail the lead along its heading (vehicles 20 m, aircraft 60 m, ships 120 m apart).
- If a group has 2+ route points the Mission Editor recomputes each unit's heading from the first leg.

## Unit types, countries, airfields
- \`dcs_list_unit_types\` searches the bundled catalogue (planes, helicopters, vehicles, ships, statics).
  Types not in it (new modules, mods) still work but the validator warns.
- \`dcs_list_countries\` gives exact country names and ids. A country can only be on one side.
- \`dcs_list_airfields\` lists airfields for a theatre with their parking capacity; aircraft groups can start
  from parking (cold/hot), the runway, or a carrier/ship.

## Countries, realism and mods
- Three different questions, three sources:
  1. What the Mission Editor allows a country: \`dcs_list_unit_types country=X\` (DCS's own, permissive list —
     Russia is allowed an A-10C). The validator warns (COUNTRY_TYPE_NOT_OFFERED) outside it.
  2. What the country really operates: \`dcs_country_inventory\` (Wikipedia snapshot). A row matches a DCS type only
     when a designation or name appears literally in both the row and the pydcs type — no outside mapping. \`exact\`
     = same full designation; otherwise a family match (Su-30MKI ~ DCS 'Su-30', a different variant).
  3. What this machine adds: \`dcs_list_installed_mods\` (Saved Games and install Mods folders, scanned as text).
     Mods are an ADDITION: DCS types always come first and are never replaced; no mods installed = same behaviour.
- A real type DCS lacks may be flyable through a mod; the inventory marks those 'mod' when one is installed.
- Templates never silently swap a type: anything the country is not offered is reported.

## SAM sites
- A site is ONE group of mixed unit types: search radar + track radar + launchers (+ command post).
  A group of launchers alone registers with Skynet and never fires.
- \`dcs_list_site_templates\` lists ready compositions; pass \`site\` to \`dcs_miz_add_ground_group\`.
  Each template states its provenance: \`engaged\` (fought in a live sortie), \`me-saved\` (copied from a
  Mission-Editor mission), \`loaded\` (flown and registered with Skynet, never engaged) or \`catalogue\`
  (every type exists in DCS; this exact layout not yet flown or opened in the editor).

## Scene building
- \`dcs_miz_add_farp\` adds a FARP / helipad; helicopters start from it with start { kind: 'farp_cold', farp }.
  support=true adds the dressing statics and a support-vehicle group — rearm/refuel comes from the vehicles.
- \`dcs_miz_populate_airfield\` parks statics (aircraft, vehicles, equipment) on free parking slots from DCS's
  own airfield data. Flights and parked statics never share a slot.
- \`dcs_miz_add_target_area\` lays out a static target set (ammo-depot, fuel-depot, command-post, supply-yard,
  barracks); \`dcs_miz_add_naval_group\` adds a ship formation (csg, lha-group, kuznetsov-group, red-sag,
  convoy) and, with airWing 'auto' or a list, the aircraft on the lead ship's deck. 'auto' keeps only types
  pydcs offers the country and (where known) the country's Wikipedia list shows it operating. Layouts are conventions, not copied from editor missions; check terrain for land targets.
- For a compound that looks like someone built it rather than like a grid, import one: \`dcs_scan_scene_candidates\`
  clusters the statics in a mission YOU supply, \`dcs_import_scene_template\` keeps each object's exact offset and
  its own heading, and \`dcs_miz_add_scene\` places that footprint anywhere at any facing. Provenance is 'imported':
  measured from your file, never flown or opened in the Mission Editor by this server, and never shipped with it.
- \`dcs_miz_add_static\` type 'big_smoke' is the editor's smoke/fire effect (the only one DCS offers) and needs
  effectPreset 1-8; aircraft and ship statics take liveryId, and hiddenOnPlanner/hiddenOnMFD hide an object from
  the planner map or the cockpit moving map alone.

## Triggers
- Types: start (mission start), once, continuous, change (fires on the false->true edge).
- Groups, units and zones are given by name and stored by id; an unknown name is an error.
- DCS runs separate start triggers in undefined order. Anything order-dependent (MIST before Skynet)
  must be in one trigger — \`dcs_miz_load_scripts\` does this for frameworks.
- F10 radio items raise a flag; pair with a continuous trigger that clears it to allow reuse.
- Conditions are ANDed in order. A \`{ kind: 'or' }\` entry between them is a separator, not a test:
  it compiles to \` or \`, so \`A, B, or, C, D\` becomes \`A and B or C and D\` — the editor's own OR
  condition group. One with nothing on both sides is refused.
- The condition surface also covers group alive, unit damaged, all-of-group / part-of-group out of a zone,
  a zone carried by a unit, unit altitude above/below (MSL or AGL) and missile/bomb in zone; the actions
  cover explosion and smoke markers at a zone or a unit, signal flares from a unit, a picture to a coalition,
  an F10 map mark, a coalition radio item, ATC silent mode, zone resize, artillery shelling and AI TASK PUSH
  (\`ai_task\`). Every one has a recorded editor spec-to-Lua pair behind it.
- The weapon selector of missile_in_zone / bomb_in_zone is the editor's own four numbers. This server does
  not interpret them and will not generate them: copy them from a mission whose condition already works.
- \`dcs_miz_add_reactive_spawn\` is the usual way to make a mission react: a trigger (zone entry, a group
  dead or hurt, a flag, a time) that activates late-activated reserves, optionally with a chance, a delay,
  a message and an AI task push. Groups to activate must already have lateActivation set, or nothing happens.

## Editing safety
- \`dcs_miz_save_as\` never overwrites the source and refuses to replace any file unless overwrite=true.
- Removing a group, unit or zone that a trigger references is refused unless you pass force=true
  (the trigger would silently never fire).
- Sessions are snapshotted to disk after every change. After a restart, \`dcs_miz_list_sessions\`
  shows restorable snapshots and \`dcs_miz_restore_session\` brings one back.

## Live bridge
- Install the hook with \`dcs_install_hook\` (or \`node dist/index.js install-hook\` from a built clone), then restart DCS.
- Aircraft diagnostics: \`dcs_aircraft_detect\` queries group-controller contacts/history by detection method without enemy world-position enrichment. \`dcs_aircraft_inspect_options\` separates authored options from bridge writes; current option/queue getters are unavailable. \`dcs_aircraft_task\` controls supported native tasks, including an explicit temporary Orbit for suspend/resume. \`dcs_support_flight_register\` starts evidence monitoring; inspect with \`dcs_support_flight_inspect\` or \`dcs_transport_verify\`. Geometry does not prove AWACS/tanker service, missing troops do not prove loading, and all observer snapshots remain separate from pilot knowledge. Requires hook capability aircraftAI=1.
- Airfield scenery should form servicing, ordnance and cargo areas appropriate to the airfield role: parked aircraft, land-based technicians, access ladders, toolboxes, ground power, ammo crates and actual bomb-cart props where available. Group props in reserved bays instead of assigning every item its own aircraft stand. Preserve flight parking and wing/rotor footprints; do not infer taxi clearance from parking data. Installed Massun92-Humans/VPC static definitions are read as data at startup; omit and report missing optional assets instead of inventing types or substituting carrier crew.
- Camp boundaries: \`dcs_miz_add_target_area\` template=barracks includes a static perimeter by default, with a 12 m front entrance; perimeter=false disables it, and a perimeter object customizes walls, padding and gates. Other target templates opt in. \`dcs_miz_add_perimeter\` wraps existing scenery in an explicit rectangle. Return data describes entrance approaches, not roads or proven vehicle paths. Leave approaches clear of further scenery; nominal wall dimensions are unmeasured layout inputs and live model/terrain checks remain necessary. Imported scenes keep their own perimeters.
- \`dcs_bridge_status\` reports \`phase\` (menu/loading/loaded/running). Mission-environment tools need
  \`running\`. A paused mission produces no simulation frames, so those tools time out with that reason.
- \`dcs_load_mission\` swaps the mission on an already-running session; it cannot start one from the
  main menu. Fly any mission first, then load. Loading is asynchronous: poll status, then read the log.

## Trains, troop transport and raw fields
- \`dcs_miz_add_train\`: a ground group of 'Train' units with the editor's own "On Railroads" route points and an empty \`wagons\` table, captured from an ME-saved mission. The path must already run along the railway — there is no offline railway graph; get rail-snapped points from \`dcs_terrain_roads\` kind=railroads while a mission runs.
- \`dcs_miz_make_troop_transport\` wires all three tasks at once: Embarking on the transport's pickup waypoint, EmbarkToTransport on the troops' waypoint, DisembarkFromTransport on the drop waypoint. They must agree on group ids and coordinates or nothing happens — no error, the helicopter just lands and leaves. Embarking/EmbarkToTransport are the editor's own field layout; DisembarkFromTransport is Hoggit-documented only. Not flown here.
- \`dcs_miz_get_value\` / \`dcs_miz_set_value\` read and write any field of the session's mission table by path (\`coalition.blue.country[1].plane.group[1].name\`). Adding a key needs create=true, removing takes remove=true, and every write is serialized and reparsed or rolled back. A raw write is your assertion about the file format, not this server's: validate before saving.
- \`dcs_list_map_icons\` lists every icon the Mission Editor's own picker offers (53 of them, read from the install) plus pydcs's nine names; \`dcs_miz_add_drawing\` kind=icon takes any of those labels and refuses anything else.

## Campaign files (.cmp)
- A DCS campaign is a plain Lua file next to its missions, not an archive. \`dcs_campaign_read\` parses and
  validates one, \`dcs_campaign_write\` writes one, \`dcs_campaign_step\` walks its branches.
- Stages are a ladder, not a graph: after a mission DCS moves up a stage on a score above 50, repeats the
  stage on exactly 50 and moves down below 50; past the last stage is a win, below the first is a loss.
- In the new stage DCS picks at RANDOM among the missions whose interval contains the score. So every stage
  needs missions covering 0-100 or the campaign stops dead ('no mission chosen'), and the start stage wants
  at least one mission whose interval ends at 100 or DCS always opens with the first.
- Mission files are not copied: DCS resolves each one against the campaign's own folder, so put the .cmp
  beside its missions. necessaryUnits is the module each mission's player aircraft needs.
- \`dcs_campaign_generate\` is a different thing: it builds mission sessions and a victory/failure manifest,
  which is richer than DCS's score ladder and is not a .cmp. Use it to design, then write the .cmp.

## Terrain
- A ground unit placed on water does not error — it just sits inert. Check placements with
  \`dcs_check_terrain\` (needs a running mission), or take coordinates from an ME-saved mission.

## Advanced authoring and terrain availability
- Use \`dcs_list_flight_roles\` for role mappings and per-aircraft pylon CLSIDs; templates never invent weapons.
- BARCAP/TARCAP use CAP, DEAD uses SEAD, group strike uses CAS; transport/reconnaissance do not configure cargo/cameras.
- \`dcs_miz_configure_flight\` validates per-unit arrays and one Player unit and checks the livery against installed Liveries folders (installed/not_installed/unknown). Callsign families (number or name) are checked per type and main task: \`dcs_list_callsigns\`. Radio bands are unknown.
- \`dcs_airfield_radio\` gives an airfield's ATC radios (HF/VHF low/VHF high/UHF MHz) and runway designators from pydcs's DCS export. Runway headings are designator x 10. Where available it adds ICAO, elevation, TACAN, VOR, NDB and ILS frequencies from DimOn's kneeboards (OCR, kept only where the row's ATC matches pydcs); an empty list means not extracted, not absent, and ILS frequencies are not tied to a runway.
- \`installBeacons\` in that same answer is ED's OWN beacon data for the installed build (Mods/terrains/<theatre>/beacons.lua, matched on the beacon ids pydcs lists for the airfield): TACAN channels, ILS/VOR/NDB frequencies, positions and lat/lon. Prefer it over the OCR'd kneeboard rows. null means no readable DCS install was found — unknown, not absent.
- \`dcs_theatre_data\` gives the same ED data for a whole installed terrain, keyed by ED's airfield<N> index. That index is NOT the mission-file airdromeId; for a terrain the bundled catalogue lacks, ids/coordinates/parking come from \`dcs_airbase_build_pack\` (sampled from a running mission, stored offline, listed by \`dcs_list_airbase_packs\`).
- \`dcs_install_report\` says which build is installed, which terrains it has, and which unit type ids it declares that the bundled catalogue has no entry for. The bundled data is pinned to pydcs, which states no DCS build, so this is coverage drift — not a version comparison.
- Inspect and edit what is there: \`dcs_miz_get_route\` (waypoints + tasks identified against the catalogue), \`dcs_miz_get_group\`, \`dcs_miz_get_unit\`; \`dcs_miz_modify_waypoint_task\` / \`dcs_miz_remove_waypoint_task\` / \`dcs_miz_set_waypoint_task_enabled\` by task number (modify refuses tasks not in the catalogue and keeps undocumented stored fields); \`dcs_miz_modify_unit\`; \`dcs_miz_list_goals\` / \`get_goal\` / \`modify_goal\` / \`remove_goal\`; \`dcs_miz_add_quad_zone\`; \`dcs_miz_set_airbase_coalition\`.
- Site templates from your own missions: \`dcs_import_site_template\` copies a ground group's types and exact layout from a .miz you supply (provenance 'imported', not flown by this project); then use it as \`site\`. Use it for systems with no built-in template; SA-5 and Rapier now ARE built in (mix and offsets copied from Skynet's own ME-saved unit-test mission, flown by nobody here).
- Loadouts: \`dcs_list_loadouts\` / \`dcs_miz_apply_loadout\` read the DCS payload library on THIS machine as data; 'unknown' when no DCS folders are found. Radio bands and per-airframe starting fuel are still not in any bundled source.
- Fuel: \`dcs_aircraft_fuel\` gives each type's internal maximum (pydcs fuel_max); \`dcs_miz_set_payload\` takes fuel in kg or fuelPercent of that maximum; \`dcs_miz_fuel_report\` audits a mission. Default starting fuel per airframe is not sourced.
- Radio bands are enforced ONLY where documented (\`dcs_list_radios\` shows band per radio; today the A-10C). Elsewhere frequencies are not band-checked and results say so. The validator checks preset structure, values, modulation and documented bands.
- Warehouse stock: \`dcs_import_warehouse_donor\` harvests real wsType entries from a mission you supply; \`dcs_miz_add_warehouse_stock\` adds NEW stock only by copying them.
- \`dcs_data_provenance\` lists every bundled dataset with its upstream, licence, pinned inputs and verification status.
- Waypoint actions: \`dcs_list_waypoint_actions\` catalogues every task, command and option on the Hoggit DCS scripting wiki; \`dcs_miz_add_waypoint_action\` appends any of them to any group's waypoint with documented params only, option ids per Air/Ground/Naval domain and validated values. Frequencies there are Hz, positions DCS x/y. Wiki = scripting-API docs, not ME-verified. Each action is cross-checked against ED's DCS User Manual (2022) editor menus: actions it does not list come back with a warning, and ship/vehicle actions the manual lists are allowed even where the wiki omits them.
- Radios: \`dcs_list_radios\` (pydcs panel_radio), \`dcs_miz_set_radio_presets\`, \`dcs_miz_reset_radio_presets\`, \`dcs_miz_set_intra_flight_frequency\`. Unknown radios/channels are refused; frequencies are NOT band-checked.
- \`dcs_miz_add_waypoint_task\` uses 1-based points; orbit altitude is MSL and speed is m/s. Frequency is MHz; SetFrequency emits Hz.
- \`dcs_terrain_analyze\` needs a sourced offline grid, an installed terrain pack, or a matching live theatre. Missing data (or a point outside every pack) returns available:false.
  Packs (\`dcs_terrain_build_pack/list_packs/remove_pack\`) are bare-earth samples of DCS's height field at the chosen spacing; buildings and trees are not in them.
  Suitability with unknown surface is indeterminate, not suitable. LOS/radar-range estimates are sampled bare-earth geometry.
- \`dcs_miz_move_ground_on_terrain\` checks every unit footprint before committing; no suitable candidate leaves the group unchanged.
- \`dcs_miz_add_threat_ring\` draws caller-supplied ranges on standard F10 layers; it does not infer weapon performance.
- \`dcs_miz_create_ground_plan\` offers configurable layouts/routes/CA flags; road connectivity and actual drivability need DCS.
- \`dcs_miz_configure_iads\` loads MIST/Skynet in order; use unique SAM group/EWR unit prefixes for one coalition.
  Configured networks register for the existing telemetry sampler, alongside legacy redIADS/blueIADS.
- Warehouse quantity editing requires existing wsType metadata. New stock uses imported donors. Supplier links may reference existing same-coalition warehouses/airfields; duplicates and self-links are refused; unknown fields survive.
- dcs_carrier_compatibility reports sourced DCS aircraft/deck pairs; unlisted pairs are unknown. dcs_miz_add_carrier_recovery appends a native ship-linked landing waypoint; unknown pairs need allowUnknown=true. Deck-slot geometry and success remain unproven until observed.
- dcs_aircraft_coverage combines fuel, dimensions, tasks, pylons, radios and installed loadouts with explicit unknowns. dcs_service_date_check and dcs_miz_historical_report check a small sourced earliest-year dataset; they do not validate retirement, other countries or the simulated avionics/store fit.
- dcs_runtime_inspect receives native events from a bounded hook observer installed at mission start, independent of telemetry globals. Event source, cursor, retention gap and truncation are explicit. These are observer data, not aircraft sensor knowledge.
- Authoritative sensor models remain unsupported.
- All new authoring/analysis is offline-tested only. Do not promote a SAM template's provenance from reasoning or unit tests.

## Structured design, assets and cinematic direction
- \`dcs_miz_configure_mission\` edits date/time/static weather, countries, briefings, bullseyes and forced options atomically.
- \`dcs_miz_assign_country\` moves an entire country and its groups. Review coalition-specific references and warehouse ownership.
- \`dcs_miz_add_drawing\` writes standard-layer lines (segment/segments/freehand), free polygons, circles, ovals, rectangles, arrows, oblong corridors, text and the pydcs standard icons, with pydcs line styles. Vertices are absolute DCS x/y, stored relative to origin. Shapes follow pydcs field names; only circle/line/polygon/text existed before and none is ME-verified.
  Manage them with \`dcs_miz_list_drawings\`, \`dcs_miz_remove_drawing\`, \`dcs_miz_clear_drawing_layer\`.
- Groups: \`dcs_miz_clone_group\` (fresh ids, whole route offset; refuses parking/ship/FARP starts, drops datalinks), \`dcs_miz_add_units_to_group\`, \`dcs_miz_find_groups_near\`, \`dcs_miz_set_route\` (keeps point 1). Group, unit and zone names must be unique; duplicates are refused.
- \`dcs_list_cloud_presets\` / \`dcs_miz_set_cloud_preset\` apply the editor's cloud presets with their base range. \`dcs_geometry\` and \`dcs_miz_points_in_zone\` are flat-grid helpers (x north, y east).
- \`dcs_miz_embed_asset/list_assets/remove_asset\` manage media and kneeboards while preserving unrelated archive entries.
- \`dcs_miz_add_goal\` writes goals and compiled results; \`dcs_miz_replace_trigger\` replaces a stable trigger index without inventing predicates.
- Unit activation is group-scoped: \`dcs_miz_add_unit_activation\` refuses multi-unit groups for independent-unit requests.
- Scenario generation requires explicit forces, starts, roles and victory/failure conditions. Difficulty sets default AI skills; threat level is not an authoritative model.
- Duration is a failure time limit. Outcome candidates are adjudicated after one second; failure wins within that window.
- Scenario media may use canonical base64 assets and symbolic asset:<id> references. Recorded audio is optional.
- Director dialogue templates are fictional. User-supplied procedure citations are unverified. No radio/sound action is emitted for missing audio.
- World-event cues filter the named initiator unit. Event-relative delays begin when the preceding trigger fires, not when its audio finishes.
- Generation reports are embedded snapshots. Use \`dcs_miz_mission_report\` for current mission data after later edits.
- CSAR is zone/flag based; there is no automatic personnel pickup. Campaign manifests do not implement automatic cross-mission state or .cmp files.
- All new formats/runtime are offline or mock tested; do not claim a DCS/Mission Editor run.

## Diagnostics
- \`dcs_status\` and \`dcs_get_log_errors\` read Saved Games/DCS/Logs/dcs.log and work with DCS closed.
  It is the only place a Mission Editor load failure or a mission script error is reported.
`;
