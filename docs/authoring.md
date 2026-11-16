# Advanced authoring and terrain planning

These additions are **offline tested, not opened in the Mission Editor or flown**.
The server remains version 0.2.0; this work is not a published release.
Existing tool names/arguments remain available. Unknown mission fields and archive
members are retained. Source missions are never overwritten.

## Flights

Start with `dcs_list_flight_roles`, optionally passing `type`. It returns role
mappings, required geometry/targets, supported aircraft tasks and pylon CLSIDs.
The new role tool is stricter than the generic aircraft tool: it requires reference
data, refuses known country/type mismatches, and validates on a copy before committing.
If no country in the snapshot lists an aircraft, country compatibility is **unknown**,
not rejected; this includes F-16C_50 in the current pydcs snapshot. Country lists
are Mission Editor availability, not a historical order of battle.

`dcs_miz_create_flight` accepts:

- `role`: CAP, BARCAP, TARCAP, SEAD, DEAD, CAS, strike, escort, interception,
  reconnaissance, transport, AWACS or tanker.
- `side`, `country`, `name`, `type`, `category`, `count` (1–4), position or `start`.
- `orbit`: point, optional point2, Circle/Race-Track pattern, altitudeMetres
  (MSL), speedMps, optional durationSeconds. Race-Track requires distinct points.
- `targetGroup`: required for escort, interception and strike; optional for
  CAS/SEAD/DEAD. Targets must exist and be on the appropriate coalition.
- `engagementDistanceMetres` and `config`.

BARCAP/TARCAP are CAP conventions, not distinct DCS main-task identifiers. DEAD
uses SEAD tasking and does not guarantee destruction. Group strike uses CAS with
AttackGroup. Reconnaissance and transport set the reference main task; they do
not invent camera/cargo behavior. No template automatically chooses weapons.
AWACS and tanker add their perform task and require an orbit. A station waypoint
is appended when an orbit is provided, so a ground start never orbits on the ramp.
CAP/CAS/SEAD add an en-route engagement task. Escort uses a resolved friendly
aircraft group id; attacks resolve opposing group ids.

Example MCP arguments:

```json
{
  "sessionId": "<session>", "side": "blue", "country": "USA",
  "name": "Hornet CAP", "type": "FA-18C_hornet", "count": 2,
  "role": "BARCAP", "start": {"kind": "parking_hot", "airfield": "Kutaisi"},
  "orbit": {
    "point": {"x": -270000, "y": 700000},
    "point2": {"x": -250000, "y": 700000}, "pattern": "Race-Track",
    "altitudeMetres": 7000, "speedMps": 210, "durationSeconds": 1200
  },
  "config": {"skills": ["Client", "High"], "tailNumbers": ["401", "402"], "frequencyMHz": 251}
}
```

Those orbit coordinates are an example, not a terrain-cleared route.

`dcs_miz_configure_flight` sets per-unit skills/tail numbers, livery, callsign,
group frequency (MHz), AM/FM modulation and fixed-wing formation. Only one Player
unit is allowed; Client is multiplayer. Callsigns accept either a numeric DCS
callsign or `{family, flight, name?}` where family is a number or a name. Families
come from the Hoggit wiki callsign enums: 1-8 generic, AWACS 1-5 and tanker 1-3 by main
task, 9+ type-specific only where pydcs `callnames` for the type is the same list
(F-16, F/A-18, A-10, B-1B, B-52). F-15E and AH-64D lists disagree between the two
sources, so their type-specific numbers are refused (`dcs_list_callsigns` says why).
Installed liveries are checked; per-aircraft radio bands are unknown and warnings say so.

`dcs_miz_add_waypoint_action` appends any task, command or option catalogued from the
Hoggit DCS scripting wiki (`data/hoggit.json`, `scripts/gen-hoggit-data.py`) to any group's
waypoint: documented params only, required params enforced, enum params (expend,
pattern, designation, modulation) checked, options by numeric id for the group's
Air/Ground/Naval domain with their documented values. The wiki describes the scripting
API; the Mission Editor may write extra fields, and none of these has been ME-verified. Arrays must contain exactly one entry per aircraft. Unknown fields remain.

`dcs_miz_add_waypoint_task` appends to a 1-based ComboTask without replacing existing
actions. Typed tasks cover Orbit (including duration), EngageTargets or a zone,
AttackGroup, Escort, AWACS, Tanker, air ROE/reaction/radar options, fixed-wing
formation, SetFrequency (MHz converted to Hz), and tanker TACAN (X/Y, 1–126).
TACAN availability on individual tanker variants still needs runtime verification.
`dcs_miz_add_airfield_landing` appends a known-airfield Land/Landing waypoint.
Carrier recovery is not exposed without stronger mission-format/compatibility evidence.

`dcs_miz_set_payload` now checks finite, nonnegative quantities against known fuel,
chaff/flare and gun limits, unique pylon indices and the generated per-pylon CLSID
catalogue. Incompatible known stores are refused before mutation. Unknown/mod types
retain generic support, but are not weapon-validated. Existing imported stores
outside the snapshot are preserved and reported as warnings, not silently removed.
The prior serialization test used a fake CLSID; it now uses a real catalogued store.

Explicit parking requests now check duplicates, category and dimensions, as automatic
selection already did. Partial dimension data no longer bypasses all fit checks.
FARP starts require helicopters and respect shared pad count across flights. Ship
starts reject ships with no reference deck parking. The pydcs `parking` number is
**not** treated as total deck capacity. Carrier air-wing construction remains available;
exact deck slots, aircraft/carrier compatibility, simultaneous launch conflicts and
moving-deck recovery are not validated. Existing runway starts do not schedule
separation between flights.

## Terrain and tactical planning

`dcs_distance_bearing` works offline without terrain: x=north, y=east metres;
bearing is clockwise from **grid** north, not magnetic or geodetic north.

`dcs_terrain_analyze` supports status, elevation, slope, suitability, profile, los,
viewshed and route operations. Radar-range and terrain-masking queries use `los`
with observer/target AGL heights and optional caller-supplied maxRangeMetres.
They are geometric estimates, never authoritative sensor detection.

Choose one explicit source:

1. `source: "offline"` with `grid`: theatre, provenance `source`, origin `{x,y}`,
   spacingMetres, rows, columns and a flat heights array. Row index increases
   north, column index east; index = row * columns + column. Heights are MSL metres,
   bilinearly interpolated. `null` is missing data. Optional surfaces use DCS
   codes 1=land, 2=shallow water, 3=water, 4=road, 5=runway, nearest node.
2. `source: "live"`: the existing structured bridge `mission` and `land` commands.
   The running mission must match the requested theatre. Queries are batched to
   at most 500 points; coordinates round to millimetres in the existing hook.
   No raw Lua execution permission is needed. This adapter has mock-TCP test
   coverage, but has not been exercised in DCS during this work.

There is **no bundled elevation dataset**. Missing/off-grid samples, disconnected
DCS or a theatre mismatch produce `{available:false, reason}`. Missing surface
classification makes otherwise-flat suitability/route results indeterminate
(`null`), never a positive land classification. No flat-terrain fallback exists.
Invalid input is an MCP error; data unavailability is a structured capability response.

Slope uses central finite differences. Suitability samples nine footprint locations
and their slope stencils. LOS samples the segment, adds geometric Earth curvature
with earthRadiusFactor=1 by default, and interpolates the observer-target ray.
A configurable effective-radius factor is an explicit approximation; no automatic
atmosphere model is implied. Viewshed returns radial cells, including inner cells;
space between rays is not evaluated. Profiles include both endpoints. Route checks
sample straight legs for water and along-route grade, not roads, bridges, cross-slope
or DCS pathfinding. A maximum of 8192 samples bounds each analysis; grids have at
most 65536 nodes. These checks cannot see trees, buildings, objects or collision meshes.
Sub-sample obstacles can be missed; choose step size appropriate to source resolution.

`dcs_miz_move_ground_on_terrain` tests caller-supplied candidate positions for an
existing vehicle group, including SAM batteries. It translates/rotates a copy using
the existing moveGroup behavior, checks **every unit footprint**, and commits the
first candidate whose surface and slope are acceptable. Unknown terrain, unknown
surface, budget errors or no acceptable candidate leave the mission unchanged.
It also refuses to commit if another MCP operation edits the mission during a live
query. This is sampled placement assistance, not a best-site optimizer or radar model.
Use suitability directly to assess a prospective FARP or static footprint.

`dcs_miz_add_threat_ring` creates a standard F10 circle from a caller-supplied range,
on Red/Blue/Neutral/Common/Author only. It preserves existing drawings/options.
The radius is an annotation, not a claim about actual SAM/weapon effectiveness.

## Surface operations and IADS

`dcs_miz_create_ground_plan` takes explicit vehicle composition and a plan:
convoy, patrol, defensive or assault; column/line/wedge/rectangle; spacing; route;
speedMps; onRoad; lateActivation; playerCanDrive. Layouts are project conventions
rotated about the lead unit. Patrols append GoToWaypoint to loop the route. Defence
is stationary. Assault moves to the supplied destinations; tactical combat success
is not simulated offline. The Combined Arms checkbox does not guarantee that a
particular unit type is player-drivable. Activation/deactivation continue through
the existing trigger actions.

`dcs_miz_add_surface_task` appends Hold, FireAtPoint or GoToWaypoint to vehicle/ship
waypoints, preserving existing actions. Fire tasks expose coordinates, radius and
rounds, but weapon reach/ammunition and type-specific AI behavior require DCS.
Existing naval formation/air-wing and route tools remain available; these additions
do not establish moving carrier launch/recovery verification.

Existing SAM templates cover SA-2/3/6/8/10/11/15, Hawk, Patriot, NASAMS and EWR.
Every battery remains one mixed group. Existing per-template provenance is unchanged;
new tests do not promote catalogue compositions to DCS-verified status.

`dcs_miz_configure_iads` embeds MIST and Skynet in the existing single ordered load
trigger, followed by generated setup. It takes SAM **group** and EWR **unit** prefixes,
coalition, go-live percentage, HARM detection percentage and optional radio menu.
Prefixes matching another coalition, no matching SAM groups, duplicate IADS names,
and missing framework files are refused. Prefix matches do not prove correct
radar/launcher composition. Its Lua uses `ipairs` for Skynet collections and reports
counts to the log and registers each network in DCSMCP_IADS for periodic telemetry. The sampler retains legacy redIADS/blueIADS and deduplicates aliased networks. Runtime engagement remains unverified. Missing framework files
or a concurrent edit do not partially commit configuration.

There is no historical service-date dataset. Country availability and Wikipedia
inventory snapshots cannot establish period correctness; no historical compatibility
claim is made.

## Logistics

`dcs_miz_list_warehouses` reads the existing separate archive member without
marking it for serialization. Without edits, that member stays byte-for-byte intact.
`dcs_miz_edit_warehouse` edits:

- Coalition (RED/BLUE/NEUTRAL), unlimited fuel/munitions/aircraft flags, fuel InitFuel quantities, operating
  levels, supply size/speed/periodicity and dynamic/hot-start settings.
- Existing aircraft quantities by category/type and weapon quantities by numeric
  entry index, retaining their wsType and opaque metadata. Supplying quantities
  makes the relevant inventory finite. Conflicting explicit unlimited flags fail.
- Supplier restrictions by retaining/removing existing Id/type records. New supplier
  links are unsupported; opaque existing records are never guessed or normalized.

`create:true` can add a pydcs-default warehouse for a catalogue airfield or existing
ship/FARP. New airfield entries default NEUTRAL rather than guessing a coalition.
Creating aircraft/weapon stock entries requires wsType reference data we do not
have, and is refused; existing unknown stock remains preserved. Fuel quantities
use the file's InitFuel units without conversion to invented mass/volume units.

Edits preserve all unnamed fields, other warehouses and unrelated archive members.
They survive save/reopen and session snapshot/restart. Malformed warehouse Lua is
never executed; inspection/editing fails safely while unrelated mission edits retain
the original member. Editing is transactional at the warehouse-table level.

## Validation and verification

MCP validation/save now also check raw aircraft payload limits, duplicate numeric
ids, parking conflicts/missing slots, type/category mismatches, task target ids and
waypoint linked-unit ids. Unknown snapshot tasks/stores remain warnings. This adds
checks without rewriting imported task data or changing trigger compiler rules.

See [verification.md](verification.md) for commands, results, generated evidence,
and the remaining DCS acceptance work. See [capability_gap_analysis.md](capability_gap_analysis.md)
for DCS-MCP’s baseline, implemented additions and remaining authoring work.
