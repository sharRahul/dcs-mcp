# Aircraft runtime inspection and control

These tools require the updated `runtime/dcs/Hooks/dcs-mcp-hook.lua`. Install with
`dcs-sortie-mcp install-hook --saved-games <DCS-profile> --force` and restart DCS.
The installer backs up a differing hook. Restart the MCP server to discover the
new tools. `dcs_bridge_status` reports `response.capabilities.aircraftAI: 1` on
the updated hook. A running, unpaused mission is needed for mission queries.

## Tools

| Tool | Purpose |
| --- | --- |
| `dcs_aircraft_detect` | Query group-controller contacts and retained history by detection method |
| `dcs_aircraft_inspect_options` | Inspect authored waypoint options, bridge option-write records and `hasTask` |
| `dcs_aircraft_set_option` | Set validated ROE, threat reaction, radar use or fixed-wing formation |
| `dcs_aircraft_task` | Inspect/set/push/pop/reset native tasking; suspend into an explicit Orbit and resume |
| `dcs_support_flight_register` | Register support-flight/transport areas, flags and future event monitoring |
| `dcs_support_flight_inspect` | Report support-flight state with evidence and observer unit snapshots |
| `dcs_transport_verify` | Report pickup/drop arrival, loading/unloading evidence and recovery separately |
| `dcs_support_flight_remove` | Remove a monitor without changing flight tasking |

## Contact information

```json
{"group":"BLUE_OVERLORD","methods":["RADAR"],"maxAgeSeconds":300}
```

Methods are `VISUAL`, `OPTIC`, `RADAR`, `IRST`, `RWR`, `DLINK`. The bridge uses
the runtime `Controller.Detection` enum, not guessed numeric values. An empty
list queries any method; several methods query their union, not separate sensor
attribution. Queries represent group-controller knowledge, not necessarily one
aircraft's own sensors or awareness.

Each contact has a diagnostic object ID for correlation, sampling time and
available detection fields. The bridge never reads target world position,
velocity, name or coalition. It reads type name only if the controller reports
type known. `lastPosition`/`lastVelocity` come only from `isTargetDetected` when
the contact is no longer visible. A currently visible contact establishes a
current sighting time; it does not supply a position through this interface.
Missing fields stay absent. `sampledAt` is query time; `lastSeenAt` is observation
time when known. An absent contact becomes stale without refreshing its sighting.

History is mission-local and separated by group and sorted method selection:
100 selections, 1000 retained contacts per selection, at most 200 query results
processed per call. `truncated` reports either contact-processing or history
capacity limits. Contacts expire after `maxAgeSeconds` (1–3600), using sighting
time if known, otherwise last API-report sampling time. `clearHistory: true`
resets that selection before querying again. Nothing polls in the background.

## Options and tasks

DCS documents setters and `hasTask`, but no getter for current options or the
full native task queue. The tools distinguish original authored options from
bridge writes and explicitly return `currentOptionsAvailable: false` and
`taskQueueAvailable: false`. Options on future waypoints may not have executed;
external scripts can override bridge writes. No default setting is invented.

```json
{"group":"BLUE_CARGO","option":"reaction","value":4}
```

Option ranges match the typed authoring interface: ROE 0–4, reaction 0–5, radar
0–3, and the six existing packed fixed-wing formations. No role/country presets
are applied. Setters report a request, not independently observed behavior.

```json
{
  "group":"BLUE_CARGO", "action":"suspend",
  "task":{"kind":"orbit","pattern":"Circle","point":{"x":-280000,"y":650000},
          "altitudeMetres":5500,"speedMps":130}
}
```

These are schema examples, not terrain/performance-validated flight plans.
`suspend` pushes a temporary `ControlledTask` Orbit with a bridge-owned stop
flag. `resume` raises that flag so the underlying task may continue. It does not
call `setOnOff` or pop another script's task. Repeated suspension and pushing a
bridge task while suspended are refused. External `setTask` can still replace
the entire queue; no snapshot/restore is claimed. `set` and `reset` clear the
native queue. `pop` removes the current native task and requires deliberate use.

Supported task inputs are Orbit, AWACS/Tanker matching the authored main task,
and Mission routes with 2–50 points. Route coordinates use map metres; altitude
is BARO metres; speed is m/s. A landing must be the final point and include
`airdromeId`. This does not validate terrain clearance, airframe performance,
airfield suitability or service usability. Arbitrary task tables, Lua and script
conditions are not accepted.

## Support-flight and transport evidence

Register a named monitor before the events of interest. Registration installs a
bounded listener for landing, takeoff, crash, death and birth, without modifying tasks.
There are at most 50 monitors and 500 recent events per mission. Re-registration
resets a monitor; removal frees its slot. Events before registration are not
reconstructed. `eventHistoryGap` indicates that the bounded event ring has lost
some post-registration coverage. Missing data produces `unknown`, not success.

Supply optional station and recovery circles as `{x,y,radiusMetres}`. All active
survivors must be airborne inside the station circle for `on_station`. A return
state additionally requires the configured `returningFlag` to equal 1. Landing
requires post-registration landing evidence plus surviving active aircraft on
the ground inside the recovery circle. Failure requires a configured failure
flag or loss events covering every registered aircraft. World snapshots are
labelled observer data and must not be fed into pilot knowledge automatically.
Ground status must explicitly be false for `inAir`; missing telemetry never
confirms landing or arrival. Landing/loss evidence is matched to registered
unit IDs; changed IDs or birth events invalidate evidence from replaced units.
Loss events alone do not override currently observed live survivors.

AWACS/tanker `serviceAvailability` remains `unknown`: geometry and task metadata
cannot prove that a radio service is usable. Test that service in DCS.

Transport registration requires pickup and drop circles. It may include `troops`
(an existing ground group), `loadedFlag`, `unloadedFlag` and a recovery circle.
Pickup/drop arrival means active aircraft observed on the ground inside that
circle. Arrival history is retained across queries. Loading stays `unknown`
unless a supplied scenario flag asserts it, in which case it is labelled
`scenario_reported`. Troop disappearance never proves boarding. Unloading can
report `observed_at_destination` when all originally registered troop identities
are alive, active and on the ground inside the drop circle. This proves their
location, not which aircraft carried them. There is no documented passenger
manifest getter; `cargoManifestAvailable` is false.

## Source and verification boundaries

- [ED detection API](https://www.digitalcombatsimulator.com/en/support/faq/1268/)
  supplies detection methods and field meanings. In particular, last position,
  velocity and time apply to contacts that are no longer visible.
- [ED controller API](https://www.digitalcombatsimulator.com/en/support/faq/1267/)
  defines queue operations and ControlledTask stop conditions, and limits its
  documented `setOnOff` support to ground/naval groups.
- [ED manual](https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf)
  and [DCS 2.9.9.2280](https://www.digitalcombatsimulator.com/en/news/changelog/release/2.9.9.2280)
  document Horizontal AAA Fire Evade and its runtime fix.

Lua 5.1 API-double tests verify data boundaries, task construction and evidence
rules. MCP contract tests verify schemas and bridge routing. These do not prove
native AI behavior, passenger carriage or service availability in a flown sortie.

## Corrected Iron Veil airfields

The previous workspace mission contained no statics. Both Iron Veil builders now
call `scripts/dev/iron-veil-airfields.mjs` after flight starts are allocated. It adds
coherent servicing, ordnance and cargo scenes at Kutaisi, Senaki-Kolkhi, Vaziani
and Tbilisi-Lochini. Aircraft use free open stands; multiple props share reserved
servicing/staging stands. Flight-start slots are preserved. These are parked
scenery, not AI flights. See [scenery conventions and dependencies](airfield-scenery.md).

`iron-veil-01-first-contact-airfields.miz` is the corrected workspace output.
Its revised scene has 79 statics, including ground crew, ladders and bomb carts.
The original mission file is retained. Archive contents and parking separation
are checked offline; visibility and taxi clearance still need a live DCS check.
