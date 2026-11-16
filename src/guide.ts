/**
 * What an MCP client needs to know to use these tools well.
 *
 * Clients never see this repository's CLAUDE.md — only the server
 * `instructions`, tool descriptions and resources. The hard-won conventions
 * therefore live here, served both as the server instructions (short) and as
 * the `dcs://guide/conventions` resource (complete).
 */

export const SERVER_INSTRUCTIONS = `DCS World mission authoring (offline .miz) and live control of a running sim.

Workflow: dcs_bridge_status first to decide live vs offline. Offline: dcs_miz_new or dcs_miz_open -> dcs_miz_* edits -> dcs_miz_validate -> dcs_miz_save_as (always a NEW file). Live: check bridge phase is "running" before any mission-environment tool or dcs_load_mission; afterwards read dcs_get_log_errors, the only channel that reports a mission that failed to load.

Conventions that are easy to get wrong:
- Map axes: x = NORTH metres, y = EAST metres. Every placement tool also accepts lat/lon and converts offline from the theatre's projection.
- Headings are DEGREES in this API (stored as radians in the file).
- Unit types are exact DCS type ids ('FA-18C_hornet', 'Kub 1S91 str'); look them up with dcs_list_unit_types, never guess. It also lists unit mods installed on this machine (dcs_list_installed_mods).
- For a realistic order of battle use dcs_country_inventory (what the country really operates, from Wikipedia, vs what DCS or an installed mod can place). dcs_list_unit_types country=X is only what the Mission Editor allows.
- A SAM site is one group of mixed types (radar + launchers): use composition or site templates (dcs_list_site_templates).
- FARPs, parked statics on airfields, static target areas and naval formations have their own tools (dcs_list_scene_templates).
- Triggers reference names in this API; unknown names are errors. Order-dependent script loads belong in ONE start trigger (dcs_miz_load_scripts does this).
- Never trust a ground coordinate you did not check: dcs_check_terrain (live) says land or water.
- Removing something a trigger references is refused unless force=true (the trigger would never fire).
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

## Triggers
- Types: start (mission start), once, continuous, change (fires on the false->true edge).
- Groups, units and zones are given by name and stored by id; an unknown name is an error.
- DCS runs separate start triggers in undefined order. Anything order-dependent (MIST before Skynet)
  must be in one trigger — \`dcs_miz_load_scripts\` does this for frameworks.
- F10 radio items raise a flag; pair with a continuous trigger that clears it to allow reuse.

## Editing safety
- \`dcs_miz_save_as\` never overwrites the source and refuses to replace any file unless overwrite=true.
- Removing a group, unit or zone that a trigger references is refused unless you pass force=true
  (the trigger would silently never fire).
- Sessions are snapshotted to disk after every change. After a restart, \`dcs_miz_list_sessions\`
  shows restorable snapshots and \`dcs_miz_restore_session\` brings one back.

## Live bridge
- Install the hook with \`dcs_install_hook\` (or \`npx dcs-mcp-server install-hook\`), then restart DCS.
- \`dcs_bridge_status\` reports \`phase\` (menu/loading/loaded/running). Mission-environment tools need
  \`running\`. A paused mission produces no simulation frames, so those tools time out with that reason.
- \`dcs_load_mission\` swaps the mission on an already-running session; it cannot start one from the
  main menu. Fly any mission first, then load. Loading is asynchronous: poll status, then read the log.

## Terrain
- A ground unit placed on water does not error — it just sits inert. Check placements with
  \`dcs_check_terrain\` (needs a running mission), or take coordinates from an ME-saved mission.

## Diagnostics
- \`dcs_status\` and \`dcs_get_log_errors\` read Saved Games/DCS/Logs/dcs.log and work with DCS closed.
  It is the only place a Mission Editor load failure or a mission script error is reported.
`;
