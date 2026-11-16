# Capability gap assessment

Assessment date: 2026-11-16. Baseline: `main`, `796860b`, package/server version 0.2.0.
The checkout initially had an unrelated package-lock.json change, retained.
Git history reviewed through the initial implementation, including trigger/compiler,
bridge-thread fixes, inventory and 0.2.0 authoring commits. GitHub open-issue search
(`repo:sharRahul/dcs-mcp is:issue is:open`) returned no issues on this date.

## Scope and evidence

This document tracks DCS-MCP's own authoring capabilities, validation coverage and
remaining implementation work. Evidence comes from the source files and tests
listed below, the repository history, local checks, and the existing verification
notes in CLAUDE.md. The public pydcs implementation (https://github.com/pydcs/dcs)
is mission-format/reference-data evidence, not proof that this project's output
runs inside DCS World.

No installed DCS World environment or real terrain elevation dataset is available
in this checkout. Airfield coordinates in the catalogue are not elevation data.

## Baseline matrix (before changes)

F = fully implemented for the stated scope; P = partial; M = missing;
T = implemented but insufficient runtime verification. Offline tests do not imply DCS verification.

| DCS-MCP capability | Baseline | Implementation evidence | Tests / verification |
|---|---|---|---|
| Read/write .miz; preserve opaque archive entries | F | src/miz/archive.ts, parser.ts, sessions.ts, security/archive-policy.ts | miz.test.ts, authoring.test.ts; offline |
| Flights: CAP/SEAD/strike/escort/intercept/AWACS/tanker templates | P | authoring.ts addAircraftGroup/setGroupTask writes task string only | authoring.test.ts; no reusable role tasking |
| Types, countries, fuel, skills, multi-ship flights | P | data/reference.ts, data/unit-types.json, authoring.ts, validator.ts | inventory.test.ts; country warnings, no task/fuel limits |
| Parking, hot/cold/runway/carrier/FARP starts | T | authoring.ts chooseParking/AircraftStart, dressing.ts | editing.test.ts, dressing.test.ts; offline only; requested slots bypass fit |
| Callsigns, liveries, radio frequencies/presets | M | no typed authoring tool | no dedicated tests |
| Payload pylons / aircraft weapon compatibility | P | authoring.ts setPayload; no pylon catalogue validation | authoring.test.ts; serialization only |
| Route and advanced task editing | P | authoring.ts addWaypoint; editing.ts updateWaypoint | authoring/editing tests; no typed advanced tasks |
| Terrain elevation/surface | P | tools/bridge.ts dcs_check_terrain, hook handlers.land | live-only; no bundled elevation data |
| Slope/suitability/profile/LOS/masking/viewshed | M | no analysis module | none |
| Radar coverage estimation | M | no sensor model | none; cannot infer authoritative detection |
| Distance/bearing and threat drawings | M | projection.ts converts coordinates only | editing.test.ts projection; no overlays |
| Terrain-aware placement/routes | P | live surface query usable manually | no automated feasibility analysis |
| Ground formations, convoys/patrols/assault/defence | P | authoring.ts mixed composition/spacing/routes | authoring.test.ts; column only |
| Activation/deactivation, triggers/zones | F | authoring.ts trigger compiler, editing.ts reference protection | trig/oracle/runtime tests; prior DCS evidence in CLAUDE.md only for listed predicates |
| SAM/EWR batteries, SA series/Patriot/NASAMS | T | miz/templates.ts; mixed groups | inventory.test.ts; per-template provenance, do not upgrade |
| Skynet configuration | P | miz/frameworks.ts; ordered embedding, e2e setup | scripts.test.ts, prior sortie evidence in CLAUDE.md; no generic typed IADS configurator |
| Country compatibility / historical period | P/M | data/countries.json, real-world inventory | inventory.test.ts; no service-date dataset |
| Carrier groups, escorts, naval routes | T | dressing.ts naval formations/air wings, authoring.ts routes | dressing.test.ts; offline only |
| Carrier landing/recovery and deck compatibility | P | ship-relative departure link only | no recovery tests; no aircraft/carrier compatibility table |
| Warehouse inventory, fuel, supply restrictions | P | archive.ts preserves warehouses as opaque member | preservation only; no editor |
| F10 drawing primitives, polygon zones, goals | M | circle trigger zones only | no drawing authoring |
| Live DCS control, log diagnostics, telemetry | F/T | bridge/client.ts, tools/diagnostics.ts, dcs/log.ts, hook, telemetry | bridge/log/hook tests; existing historical DCS evidence, no new live run |

## Baseline checks

`npm run build && npm test`: PASS; 131 tests, 126 passed, 5 skipped,
0 failed. Skips require DCS_LUA. CI is build/test on Windows Node 18/20/22,
plus `npm pack --dry-run` on 22. This environment is Linux; local checks cannot
claim a Windows CI or Mission Editor run. No lint script exists; build is the
strict TypeScript check. Final changes and reproducible checks are recorded in
verification.md and authoring.md.

## Changes implemented in this checkout

New behavior is **offline tested only**. Historical DCS evidence in CLAUDE.md is
retained as prior project evidence, not a test performed during this assessment.

| Capability | Result / implementation | Evidence and remaining limits |
|---|---|---|
| All 13 requested flight roles | New miz/flight.ts, tools/advanced-authoring.ts | flight.test.ts tests every role and round trips; aliases documented, transport/camera behavior remains partial |
| Flight skills/identity/radios/formations | configureFlight + typed waypoint options | flight.test.ts, advanced-server.test.ts; radio bands, callsign families and installed liveries unknown |
| Aircraft/country compatibility | Reference task/category checks; strict known country mismatches; absent-everywhere means unknown | flight.test.ts; pydcs country coverage gap for F-16C_50 documented; no historical-date coverage |
| Fuel and aircraft/pylon compatibility | Generated data/authoring.json + gen-authoring-data.py; authoring.ts validates before mutation | flight.test.ts; authoring.test.ts now uses catalogued store; mod data remains unknown |
| Requested parking and FARPs | Fit/duplicates/occupied-slot checks, shared FARP pad counts, helicopter-only FARPs, reject ships without reference deck | flight.test.ts, existing editing/dressing/inventory tests; no total carrier capacity claim |
| AWACS/tanker orbit, radio, TACAN | Typed role tasks, Circle/Race-Track, duration, frequency, tanker beacon | flight.test.ts; actual service availability untested in DCS |
| Airfield recovery | New known-airfield landing tool | advanced-server.test.ts; carrier recovery and moving-deck geometry remain partial |
| Elevation/slope/profile/suitability | terrain/analysis.ts + providers.ts, tools/terrain.ts | terrain.test.ts analytical planes/grids; no bundled real elevation dataset |
| LOS/masking/radar-range approximation/viewshed | Sampled curvature-aware geometry, explicit source/resolution, bounds | terrain.test.ts ridge/altitude/range/curvature; no authoritative sensor model |
| Distance/bearing | Grid geometry, no terrain assumptions | terrain.test.ts axis/zero-distance checks |
| Terrain-aware SAM/ground positioning | tools/terrain-placement.ts checks every unit footprint at candidate locations before mutation | advanced-server.test.ts actual MCP placement/rejection; no best-site optimizer |
| Route feasibility | Sampled straight-leg grade/surface | terrain.test.ts; no road/bridge/mobility network |
| Threat/range overlay | operations.ts standard F10 circles, caller-supplied range | operations.test.ts, advanced-server.test.ts; icons not implemented; Phase 4 adds lines/polygons/text |
| Ground formations and role plans | operations.ts column/line/wedge/rectangle, convoy/patrol/assault/defence, CA flag | operations.test.ts round trips and geometry; AI execution/CA type support needs DCS |
| SAM battery catalogue/EWR | Existing templates preserved, additional all-template single-group round-trip test | operations.test.ts; no provenance upgraded, no historical service dates |
| Configurable Skynet setup | miz/iads.ts ordered framework loading, prefixes, go-live/HARM/menu settings | operations.test.ts Lua 5.1 syntax; verify:lua51 mocked runtime; real frameworks/DCS not run |
| IADS telemetry compatibility | scripts/dcs-mcp-telemetry.lua samples configured registry plus legacy globals, deduplicating networks | stock Lua 5.1 mocked harness; periodic runtime in DCS still unverified |
| Naval routes and tasks | Existing formation/air-wing tools plus typed surface Hold/FireAtPoint/GoToWaypoint | inventory/dressing/operations tests; moving carrier recovery/deck slots not implemented |
| Logistics editing/preservation | miz/logistics.ts, sessions.ts; stock/fuel/restrictions/defaults, existing suppliers, persistence | logistics.test.ts and MCP save/reopen; new stock wsTypes/supplier links unsupported |
| Existing-mission diagnostics | advanced-validation.ts checks known raw refs, ids, payload and parking; existing trigger/log protections retained | flight.test.ts includes EPLRS/unknown-task preservation; no rewriting of opaque tasks |
| Reproducible artifact/CI | verify-capabilities.mjs, verify-lua51.mjs, Windows workflow adds typecheck and artifact | verification.md; Linux checks do not establish Windows CI success |

## Remaining DCS-MCP work

Missing or partial work includes full radio presets, installed-livery discovery,
aircraft/country callsign family data, carrier deck-slot/aircraft compatibility and
recovery planning, polygon trigger zones, F10 icons, and creation of warehouse stock/supplier identifiers. Historical-period
checks require a dated equipment database. Real terrain analysis requires a supplied
sourced grid or DCS; baked terrain extraction/distribution is not implemented.
Surface tasks and role templates still need Mission Editor and flight acceptance.
No reliable evidence justifies declaring those gaps closed.

Existing weather and briefing editing remains available. A full weather preset,
radio preset and kneeboard suite remains future DCS-MCP work. Capability status
reflects this repository's implementation and evidence only.

## Mission design and scenario additions (Phases 4–6)

The implementation now also includes atomic mission configuration, explicit country
transfers, static atmospheric settings, coalition briefings, bullseyes, aircraft
NavTargetPoints, standard-layer F10 lines/polygons/text, goals with compiled results,
full trigger replacement, counters and single-unit-group activation.

Asset tools manage audio, briefing images, kneeboards, scripts and media, including
reference-aware removal, final archive limits and restart preservation. Independent
scenario validation/generation covers eleven mission families, seeded variation,
explicit force/support requirements, duration/outcome rules and complete reports.
Campaign generation produces a validated stage/transition manifest. The cinematic
director compiles condition/dependency/world-event cues and explicitly fictional radio
scripts, with optional audio, placeholders, shot lists and highlight suggestions.

Implementation: src/miz/configuration.ts, drawings.ts, assets.ts, scoring.ts,
director.ts, report.ts, trigger-schema.ts; src/scenario/engine.ts and
src/tools/mission-design.ts. Tests: design.test.ts, scenario.test.ts and
design-server.test.ts; stock Lua harness: scripts/lua51/design-runtime.lua.
See mission_design.md and verification.md for exact support and limitations.
No trigger oracle mappings or existing DCS verification claims were promoted.


## Bridge, acceptance, security and API additions (Phases 7–11)

| Capability | Status | Implementation and evidence |
|---|---|---|
| Runtime group/unit state, user flags, objective flag inspection | Offline protocol tested; DCS pending | src/tools/runtime.ts, src/bridge/client.ts, hook handlers.runtime; tests/fixtures/hook-runtime.lua |
| Lifecycle, safe running-mission swap, load errors | Partial; cold-menu launch unavailable | hook status/loadmission callbacks; tests/fixtures/hook-load.lua; no cold-menu network-host fallback |
| Event monitoring | Bounded telemetry ring; DCS pending | scripts/dcs-mcp-telemetry.lua, hook runtime cursor; 256 retained events, 200 per query |
| Bridge recovery and resource limits | Implemented; mocked transport tested | 4 MiB requests, 8 MiB client responses, timeouts, 32 pending hook clients, partial writes; tests/bridge.test.ts |
| Safe saves and archive policy | Implemented; regression tested | src/security/files.ts, archive-policy.ts, src/miz/archive.ts; tests/acceptance.test.ts plus existing archive/session tests |
| Dependency remediation and public schemas | Zod 4 migration implemented | 102 schema hashes, SDK client calls, existing contract tests; single verification.md records reviewed differences |
| Offline acceptance and ten reproducible missions | Implemented; live pending | src/acceptance/{cases,package,checks}.ts, tests/acceptance.test.ts, scripts/verify-acceptance-lua.mjs |
| Log/evidence collection and operator results | Implemented; synthetic regression tested | src/acceptance/collect.ts; source preservation, bounded reads, hashes, identity/outcome correlation; no screenshot interpretation |
| MCP acceptance jobs and discovery | Implemented | src/tools/acceptance.ts, catalogue.ts; one generation job at a time, bounded process-local history, status polling |
| Windows flight acceptance package | Ready for operator execution | docs/testing/live-acceptance (six documents); generated manifest lists exact units, geometry, tasks, triggers, frequencies, procedures and limitations |

Remaining work: execute every live matrix variant in DCS; import a native positive
warehouse inventory donor for stock exhaustion; collect genuine Mission Editor
save/reopen preservation evidence; verify JTAC designation, moving carrier deck
operations, AI routing and terrain. Full authoritative sensor/terrain models,
period-compatible equipment datasets, native .cmp campaigns, pickup/rescue logic,
and the complete Mission Editor predicate/action catalogue remain incomplete.
Do not mark these items closed based on offline tests.

## Drawings, radios, groups, weather, liveries and terrain packs — 0.3.0

Offline tested only (tests/gap.test.ts, tests/extended-server.test.ts). Format evidence is
pydcs 1.0.0; no new item has been opened in the Mission Editor or flown.

| Capability (baseline above) | Now | Evidence and remaining limits |
|---|---|---|
| Unique names (groups/units/statics/zones) | F | `assertNamesFree`, zone check in `addTriggerZone`; refusal leaves the mission untouched. Validator already reported duplicates |
| Radio presets / intra-flight frequency (was M) | P | src/miz/radios.ts from pydcs `panel_radio`/`radio_frequency` (88 airframes with presets). Unknown radios/channels refused. **No band data exists in pydcs: frequencies are not band-checked** |
| Installed liveries (was M) | P | src/dcs/liveries.ts, pydcs LiveryScanner paths; installed / not_installed / unknown. Zipped liveries listed by id only |
| Callsign families | P | src/miz/callsigns.ts: Hoggit wiki enums (generic/AWACS/tanker/type-specific) cross-checked with pydcs callnames; F-15E/AH-64D lists conflict between sources and are refused. Russian numeric callsigns accepted unvalidated |
| Full waypoint task/command/option table | P | src/miz/actions.ts + data/hoggit.json: 58 tasks/commands and 31 options from the Hoggit wiki with params, required params, applicability, option ids/values. Scripting-API shapes; ME extra fields not reproduced. Cross-checked against ED's DCS User Manual (2022) editor menus (data/me-manual-actions.json), literal label matches only |
| F10 drawing primitives (was M) | F (format) / T | all pydcs primitives incl. oval, rectangle, arrow, freehand line, icons (9 pydcs standard icons only), line styles, list/remove/clear layer. ME rendering unverified |
| Group clone / grow / spatial search / route replace | F (offline) | src/miz/groups.ts; clone refuses parking/ship/FARP starts and drops datalinks |
| Cloud presets | F (offline) | src/miz/weather.ts, 30 pydcs presets with base ranges |
| Terrain elevation offline (was live-only) | P | src/terrain/packs.ts: packs sampled from DCS `land` via the bridge, stored on disk, used offline. Bare-earth, resolution = chosen spacing, 262,144 nodes per pack. No pack has been built against a real DCS install yet |
| Geometry helpers / point-in-zone | F | src/miz/geometry.ts; flat grid, x north / y east |

| Airfield ATC radios / runways | P | src/data/airfield-radio.ts + data/airfield-radio.json from pydcs's airport export: 4 ATC radios (where pydcs has them) and runway designators for all 771 airfields. Navaids (TACAN/VOR/NDB/ILS), ICAO and elevation for 400 of them from DimOn's kneeboards by OCR, ATC-gated against pydcs (src: scripts/gen-airfield-navaids.py). Magvar absent |
| Route/task inspection and editing | F (offline) | src/miz/route-edit.ts: get route/group/unit; modify/remove/enable waypoint tasks through the catalogue |
| Per-unit edits / goal management | F (offline) | src/miz/units.ts, src/miz/goals.ts (pydcs goals.py result indexing) |
| Quad zones / airbase ownership | F (offline) | src/miz/zones.ts (pydcs TriggerZoneQuadPoint); warehouse coalition |
| SA-5, Rapier and other sites | P | No built-in template (no ME-saved source). src/miz/site-import.ts imports any site from a user-supplied mission (provenance `imported`) |
| Payload-library loadouts | P | src/dcs/payloads.ts reads the user's DCS UnitPayloads as data; unknown without a DCS install |

Still open from this list: radio bands and starting fuel per airframe (neither pydcs nor the
Hoggit wiki has them; the wiki only links an external spreadsheet for radios), and
DCS-install-derived (rather than pydcs) data.

