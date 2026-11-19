# DCS-MCP verification

Single verification record. Historical results retain their original scope; later native results below supersede earlier offline-only statements for the checks they cover.

## Player starts and theatre launcher survey — 2026-11-19

The nine clean example archives each contain exactly one expected Player slot.
Their mission tables match generation from the current scenario sources. Native
DCS 2.9.31.29434 cockpit starts passed for interception, SEAD strike, convoy
escort, carrier defence, military-base attack, A-10C II CAS and Su-25T CAS.
Each reached a live cockpit with a ticking simulation, the expected aircraft
type and no bridge errors; the carrier example started on the Stennis deck.
These checks establish cockpit entry and spawn, rather than a flown sortie or
recovery. Apache and Ka-50 III cockpit entry remains untested because those
modules are unavailable on the verification host; their earlier AI scenario
checks retain their separate scope.

Isolated native probes also sampled 119 launchers across eleven installed
theatres. All retained full health after at least 30 simulation seconds and
had dry terrain at a 5-by-5 grid across the rotated native unit footprint.
The scenery queries covered 1,044 overlapping candidate areas, not every
location on each map.

| Theatre | Candidate areas queried | Launchers sampled |
| --- | ---: | ---: |
| Germany Cold War | 70 | 16 |
| Sinai | 78 | 12 |
| Persian Gulf | 147 | 12 |
| Caucasus | 459 | 12 |
| Syria | 151 | 12 |
| Nevada | 54 | 12 |
| Kola | 44 | 12 |
| Mariana Islands | 10 | 10 |
| Falklands | 4 | 4 |
| Iraq | 22 | 12 |
| Afghanistan | 5 | 5 |

Sinai queries discovered 1,334 named SAM mound scenery instances, including
two crash variants. Kola queries found 34 named SAM revetment instances.
No matching named models were found in the other surveyed areas; that does
not establish absence of terrain-built or differently named prepared sites.
Marianas WWII had no SAM candidates in the available layout inventory.
Normandy and The Channel were not installed and received no native coverage.

Full launcher-to-inner-pad mesh fit remains **unverified**. Germany's sixteen
SA-3 samples across the four catalogued candidate sites were essentially flat
and their native footprint-volume scenery queries returned no objects.
Equivalent conservative queries were clear for all twelve Kola samples,
all five Afghanistan samples and eleven of twelve Iraq samples. One Iraq Osa
candidate returned a silo, which flags a possible overlap rather than proving
a physical collision. Sinai queries returned nearby SAM mound scenery for
ten of twelve launcher footprint volumes; the two Patriot volumes were clear.
Sinai's footprint samples include a Patriot with 1.466 metres of
terrain height variation and an SA-3 close to a mound origin. Those positions
must not be advertised as confirmed pad fits.

Scenery descriptors did not expose collision bounds. Terrain visibility rays
also passed through ordinary building controls, so they cannot certify wall
clearance. Spatial queries detected building controls away from their origins,
but remain conservative volume checks rather than tests of hollow revetment
meshes. Accordingly, catalogue `equipmentFit` values remain `unverified`.
Sinai also logged missing terrain assets during loading, so the completed
probe is not evidence of an error-free terrain installation or visual result.
Private probes, source layouts, generated missions and raw logs remain ignored
and are excluded from the publishable package. DCS was stopped after testing;
the original `Export.lua` hash was unchanged and raw execution stayed disabled.



## Ground compounds, road movement and Germany sites — 2026-11-19

Added five designed scenery footprints through the existing target-area tool:
farp-staging, vehicle-staging, scud-base, sam-support and military-base. They
include gated boundaries and central approach space. Existing barracks retain
their perimeter; legacy depot grids retain their geometry. Results distinguish
designed footprints from grids and explain which operational assets must be
added separately. No scenery-only preset creates an active launcher or supply
service. See [ground-sites.md](ground-sites.md).

Ground plans now default convoy transit to native On Road actions and assault
plans to native Rank (Line Abreast), rather than changing only spawn positions.
Per-point movement/speed settings support authored transit/deployment changes;
following points inherit the movement. Scenario vehicle forces accept groundPlan;
aircraft and site-template forces reject it. The five moving-ground examples
use explicit transport or assault roles. Automatic enemy-triggered deployment
is not implemented.

Native Caucasus fixture: **10 checks passed**. All **2,542** compound/FARP/boundary
statics existed and were on dry terrain; a support FARP and active SCUD vehicle
spawned. A truck physically traversed the compound entrance. Both opposing
three-tank groups moved in line-abreast formations, then fired in native combat.
Three road trucks completed their native graph route; the maximum observed road
offset during the test interval was below **2.4 metres**. This checks the exercised
layouts and actions, not universal AI tactics or arbitrary terrain clearance.
A separate same-group probe subsequently changed from native road transit to a
moving line-abreast formation (99.16 m lateral spread, 6.46 m longitudinal spread
at the passing observation). A UH-1H made an actual hot departure from the new
FARP staging compound, reaching 46.9 m AGL by mission time 44 seconds.

The new dcs_list_terrain_sites reference tool has four community-sourced Germany
candidates, independently checked in native DCS 2.9.31.29434: Rostock, Parchim,
Wismar and northern Rügen. All **eight coordinate/surface checks passed**;
projection differences were at most **0.031 metres**. Native scenery queries
within 250 metres found respectively 19, 22, 14 and 28 infrastructure objects,
including military buildings, tents, stores and gates. Records retain their
community source and separate the native observation from equipmentFit=unverified.
This is not a catalogue of every prepared site or verified radar/launcher pad fit.
No third-party mission files or terrain assets are redistributed.

The revised example ground layouts were re-sampled against DCS: **2,292 terrain
points and 70 ground/FARP scenery probes, no detected faults**. Detailed local
evidence and disposable fixtures are under ignored .verification-sites-20261119/.

Re-ran all five examples whose ground movement changed: A-10C II, Su-25T,
Apache, Ka-50 III and River Road. All **39 director phases and 116 assertions**
passed, including the complete Apache and River Road convoy journeys. Together
with the four unchanged, source-matched cases from the earlier run, current
coverage remains **70/70 director phases and 209 native scenario assertions**.
The final evidence audit matched each source hash and test-archive hash. Native
logs contained no mission script errors.

Read-only review found and fixed a validation/generation mismatch for ground
route speeds and defensive routes; both paths now use shared validation. Final
automated result: **366 passed, zero failed, zero skipped**, with native Lua and
pinned pydcs sources. TypeScript check/build and package hygiene passed. Only
source, tests, examples, source metadata and documentation are committed; no
local manuals, private harnesses, raw logs, generated mission archives or personal machine paths.

After all tests, clean playable archives were generated with exactly one Player
aircraft each, with no private fixture scripts. No DCS retest followed that
control setting. DCS was stopped and the original Export.lua restored byte-for-
byte (verified by SHA-256); no DCS process or window remained.

## Native scenario execution follow-up — 2026-11-19

DCS 2.9.31.29434 MT, Caucasus. Acceptance checks whether the authored scenario
executes: valid spawns/stores, departure, phase conditions/actions, timed releases,
movement, protected-asset responses and required egress/arrival. Combat victory
is a player-dependent outcome, not the acceptance criterion.

Each final JSON generated an isolated, hash-pinned test mission. Its player group
was converted to AI with the original start, placement and stores. The fixture
held fire to isolate conditions, issued labelled native AI entry/egress decisions
and removed labelled world objects to supply target/protected-loss preconditions.
It never wrote scenario flags: the original triggers had to observe conditions,
set phases, activate groups and arbitrate outcomes. Takeoffs, zone entries,
vehicle/ship movement and convoy arrival were physical DCS simulation. Optional
intercept/carrier landing callbacks were dispatched synthetically; these verify
the callback conditions, not an actual recovery flight. Uncontrolled combat runs
also observed native weapon releases, kills, reinforcements and player-loss
responses, but are not used to require an AI win.

| Example | Director phases observed | Native assertions passed | Distinct execution checks |
| --- | ---: | ---: | --- |
| Northern Watch | 7/7 | 18 | Hot departure, 30-second contact cue, MiGs after 90 seconds, defenders-loss response, target-clear and optional landing callback |
| Copper Corridor | 7/7 | 26 | Radar-unit loss, Hornet release after 20 seconds, MiGs 45 seconds later, logistics condition and player-loss arbitration |
| Blue Water Shield | 8/8 | 20 | Stock Stennis deck departure, moving carrier/escort, second raid at 300 seconds, carrier-loss response and both raid-clear conditions |
| Iron Gate | 9/9 | 29 | Perimeter entry, 60-second scramble, command/logistics/armour conditions, Ranger loss, actual egress |
| Valley Shield | 8/8 | 26 | A-10C II departure, Battle Area entry, 90-second reserve release, tanks/reserve movement, protected-armour response and egress |
| River Relief | 8/8 | 23 | Su-25T runway departure, 60-second primary-loss reserve delay, reserve movement, protected-armour response and egress |
| Dust Escort | 8/8 | 23 | Hot Apache FARP departure, 30-second reserve delay, both protected trucks reaching their destination, critical-truck response and egress |
| Black Shark Counterbattery | 8/8 | 22 | Cold Ka-50 FARP departure, 45-second supply-loss reserve delay, reserve movement, egress and protected-FARP static-loss condition |
| River Road | 7/7 | 22 | Actual four-vehicle route completion, checkpoint ambush, 90-second reinforcement delay, cargo-loss response and settled outcome arbitration |

All nine examples passed: **70/70 director phases and 209 native assertions**.
The first convoy observer sampled an unresolved outcome before the documented
one-second arbiter window elapsed. A corrected observer waited for resolution;
the unchanged mission passed the full native rerun. No mission script errors were
found in the final preserved logs.

All authored F10 annotations were checked for native identity, text and position.
Player stores were counted through native unit ammunition data. Late groups had
to be initially inactive and active only after their release. The negative cases
latched failure before later target-clear phases; the Ka-50 case latched success
before a later pad-loss cue, checking that an already-final outcome stays locked.
Public specifications retain exactly one Player slot each; AI conversion and
fixture interventions exist only in ignored test copies.

Native geometry checks found and corrected five problems:

- Northern Watch's second defender was in water: shift the group 100 metres north.
- River Relief's reserve route crossed water: add a sampled dry detour.
- River Road's convoy stalled against scenery: use 35 native road-graph points.
- Dust Escort's trucks/reserve overlapped scenery: shift those spawns 20 metres.
- Iron Gate's compound was on steep terrain: move its ground forces to a flat,
  clear site and adjust related routes/zones while retaining a distinct ingress.

The final native terrain audit sampled **2,292** placement/route points with no
surface or altitude faults. Scenery/gradient probes covered **70** ground/FARP
spawns with no reported faults; Iron Gate's 11 ground units also had under-five-
degree sampled slopes and 15-metre scenery clearance. These are sampled checks,
not continuous collision-clearance guarantees. Combat stores and balance were
retained; no AI-win loadout changes were kept. Carrier radio aids/recovery routes,
JTAC services, helicopter player cockpits and qualitative combat balance are
outside these functional checks.

Local evidence is under ignored .verification-examples-20261119/: hash-pinned
functional-manifest.json, per-mission *-functional-result-*.json, preserved native
logs, terrain-final.json and scenery-all.json. Generated test archives, raw logs,
absolute machine paths and test-only control scripts are excluded from GitHub
and the package.

Final repository checks: **354 tests passed, zero failed, zero skipped**, using
installed DCS Lua and pinned pydcs sources; TypeScript check and build passed.
The package dry-run includes all nine JSONs and the scenario README, with zero
local verification artifacts. DCS was terminated after the final test; no DCS
window remained. The temporary time-acceleration export was removed and the
original Export.lua restored byte-for-byte, verified by SHA-256.

## Fixed-wing CAS and attack helicopters — 2026-11-19

Added Valley Shield (A-10C II armoured defence), River Relief (Su-25T roadblock
relief), Dust Escort (AH-64D Apache convoy escort from a hot FARP start) and
Black Shark Counterbattery (Ka-50 III artillery-vehicle attack from a cold FARP
start). Each has distinct targets, compatible explicit stores, reinforcement
triggers/delays, a protected friendly asset and mandatory egress. Apache also
requires surviving convoy arrival; Ka-50 protects the Forward Pad static unit.
No real-world operation, automatic JTAC/laser service, terrain-following route,
artillery fire mission or FARP resupply service is asserted.

Tests verify deterministic generation, stored aircraft variants, compatible
payload stations/fuel, helicopter linkUnit/helipadId references, Lua syntax and
saved-archive round-trips. Sixteen new mocked Lua cases cover reserve timing,
partial-target/egress/convoy gates and protected-asset failure in both trigger
orders. Full suite with DCS Lua and pinned pydcs source: **354 passed, zero
failed, zero skipped**. TypeScript/whitespace checks passed; npm dry-run includes
all four new CAS files. This was the initial offline result; native functional follow-up is recorded separately below.

## Military-base ground-attack example — 2026-11-19

Added Iron Gate (examples/scenarios/ground-attack-base.json): a Hornet two-ship
with explicit GBU-38/air-to-air stores, independent command/logistics/armour
vehicle target groups, Osa/Shilka defence, allied F-16 SEAD, AWACS/tanker support,
a zone-triggered delayed scramble, friendly Ranger-1 protection and post-strike
egress. The base is a fictional vehicle compound; no buildings/static targets,
real-world installation or automatic target designation are claimed.

The example joins the collection's deterministic generation, payload validation,
Lua syntax and saved-archive round-trip checks. Four additional mocked Lua cases
exercise both trigger orders for success/protected-unit failure: incomplete target
sets and completed targets without egress cannot win, and scramble timing is checked.
Full suite: **346 passed, zero failed, zero skipped** with DCS Lua and pinned
pydcs sources available. TypeScript and whitespace checks passed.
No DCS flight was run at this initial offline stage; see the later native functional follow-up.

## Expanded scenario examples — 2026-11-19

Updated Northern Watch with explicit Hornet/hostile stores, a conventional Su-24M
strike pair, AWACS/tanker support, protected-force failure, delayed MiG activation
and a landing-event cue. Added Copper Corridor (radar-gated SEAD/strike release),
River Road (convoy/zone-triggered ambushes) and Blue Water Shield (ship-linked
Hornet start and two naval-strike waves). All examples use existing schema fields.
The scenario README describes objectives, phase flags, generation/revision steps
and terrain, AI, audio and carrier-recovery limits.

Automated checks generate every JSON twice, compare mission data, validate
catalogued store stations/fuel, parse generated Lua and save/reopen the archive.
Sixteen Lua mocked-runtime cases cover success/protected-asset failure in forward
and reverse trigger order, strike-release delays, reinforcement gates and premature
victory prevention. CI's stock Lua job now runs the example checks explicitly.
Full suite with pinned pydcs sources and discovered DCS Lua: **344 passed, zero
failed, zero skipped**. TypeScript check and build passed; package dry-run includes
all four JSON files and their README, and excludes local mission drafts.
These checks do not establish terrain clearance, AI combat behavior or DCS flight
acceptance for the example missions. See the later native functional follow-up for simulator results.

## Skipped-test follow-up — 2026-11-19

The final pre-push run of 897232b had 323 passes and nine skips. Seven skips came
from DCS_LUA not reaching the test process; three test files also independently
searched only default install locations. They now share discovery using the
server's DCS_INSTALL_DIR / dcs.log / standard-install detection. An explicit
DCS_LUA path that is not a file is an error, not a silent skip. Two regression
tests cover non-default roots, log discovery and invalid overrides.

Created caucasus-empty.miz from New Mission in DCS's Mission Editor and saved it
without modifying the archive. The manifest pins its SHA-256; native archive
round-trip and preservation checks now run from a fresh checkout. This is an
empty-mission fixture, not evidence for combat units or flight behavior.

Downloaded the pydcs 1.0.0 wheel into ignored local verification storage and
verified SHA-256 584570bf42bbfabbb1257bc737eb232d21aa7814cba7dfe0ba653a36aa993dd5
(the same pin as CI). With PYDCS_SRC pointing to its unpacked root, all five
pydcs-derived datasets regenerated byte-for-byte. Full suite: **335 passed,
zero failed, zero skipped**; TypeScript check and build passed. DCS was closed
after the checks. Local detailed output: .verification-production-20261118/skips-fixed-tests.log.

Lua checks still require an installed DCS interpreter or DCS_LUA. Reproducibility
requires PYDCS_SRC; ordinary runs without this optional source archive retain
one explicit skip. The dedicated CI provenance job downloads and verifies it.

## Coverage audit and mission-production workflow — 2026-11-18/19

The remaining coverage was audited rather than treating unknown data as implemented.
The catalogue has 170 aircraft: 170 fuel, dimension and task records; 147 pylon
records; 88 radio-preset records; three country-scoped historical lower-bound
records; no carrier deck-slot geometry. New exact-type numeric report profiles
require source URL/scope and retain field provenance. They fill missing report
fields only, never replace bundled values or alter authoring defaults. Added the
USAF-sourced A-10C/USA 2007 lower bound, explicitly excluding A-10C_2 fit dates.
No universal deck, retirement, other-operator or physical supplier-delivery claim
is made. See authoring-coverage.md and dcs_authoring_coverage_audit.

### Coherent production pipeline

- New production projects persist immutable plans, sequential immutable .miz
  revisions, notes, SHA-256 identities, saved-byte validation and flight evidence.
- Six MCP tools cover create, generate, revise/import, validate, capture and
  status. Concurrency/stale writers, altered plans and changed archive bytes
  are rejected. New revisions start without inherited flight evidence.
- Capture correlates two live mission-name checks, the unique latest revision
  log marker and saved archive hash. It records native snapshots and a bounded
  log tail, paginates retained events and evaluates only declared checks.
  This correlation is not simulator byte attestation or full playability proof.
- scenario_outcome resolves the current generated victory/failure flag without
  guessing allocator IDs; ambiguous/imported logic remains unknown. Manual
  qualitative checks remain unknown automatically. Status exposes next actions.
- The bundled dcs-mission-production skill ships with npm and is served at
  dcs://skills/mission-production plus its contracts resource. produce_mission
  is the built-in prompt; server instructions route complete mission work to it.
- Fixed a separate generation defect found while joining the workflow: selected
  site-template offsets and per-unit headings were dropped by generateScenario.
  It now preserves them instead of silently using a column. A Rapier-layout
  regression failed before the fix and passes after it.

### Verification

Typecheck and build pass. Full Windows/DCS-Lua suite: **332 tests, 330 passed,
zero failures, two skips** (native fixture corpus and PYDCS_SRC regeneration
inputs not supplied). Real stdio tests cover project restart, revision edits,
wrong live identity, missing evidence, plan/archive integrity, concurrent writers,
paginated events and logical outcome flags. Public catalogue: 196 tools.

Skill quick_validate passes. An independent agent used the skill through real
stdio calls, generated a 2003 F-16 CAP draft, made opposition/fuel revisions,
reconnected and correctly reported revision 3 as flight_pending with no inherited
evidence. Its outcome-flag guidance gap was addressed with scenario_outcome; a
fresh-project stdio test resolved flag 1003 while retaining flight_pending.
An extracted npm tarball successfully served both skill resources and the
production prompt; all 196 tools were discovered. No global skill installation
is required to use the bundled MCP prompt/resources.

Independent code review found a regeneration path that checked revision count
without validating the existing head. A failing regression reproduced changed
acceptance criteria being accepted; head validation now rejects it. Focused
re-review found no remaining actionable defects.

### Live production round trip

DCS 2.9.31.29434 MT, Caucasus; agent clicked FLY, no user flight/test input.
The prior autonomous mission was imported as revision 1. The initial test process
lost its targetable window before flight and was excluded from evidence; it was
stopped and restarted.

Revision 1 (ed145ba5-cd60-4e15-b273-c70d063976c5) captured at t=24.753:
all three declared checks observed — EventTarget-1 native DEAD event, EditorSAM
spawn, and no detected mission-script problems after the revision marker.
SHA-256: ba97058f27ef7725370e37cd848cfc6478d2b281a384fc3b06f2acc0c95165f1.

The observer fuel was then changed and checkpointed as revision 2. Its status
returned flight_pending with zero evidence records. A capture while DCS was
still running revision 1 was rejected with live mission identity mismatch.
Revision 1's archive and evidence were preserved.

Revision 2 (4d5ef65d-1c0b-4d5f-a933-404eae2fd683) was launched separately and
captured at t=20.221. Its own three declared checks were observed, yielding
declared_checks_observed without reusing revision 1's flight evidence.
SHA-256: 7c79d365a6621fb7509eeba8817bf888cf2b9394dd0099c15d833b02f763d314.

Local evidence: .verification-production-20261118/summary.json, live-project/,
flight-1.json, flight-2.json, stale-evidence-rejection.txt, preserved dcs-*.log,
tests.log, coverage-audit.json, skill-eval/ and package-smoke.json.
These named checks establish the production/evidence lifecycle, not a complete
combat sortie, universal aircraft tactics or usable radio service. **DCS was
terminated after the tests and no DCS window remained.**

## Runtime events, site evidence and authoring coverage — 2026-11-18

Implemented against checkout b5ddde1 plus this working tree. DCS was launched and
controlled by the agent; the user did not have to fly or execute manual checks.
DCS 2.9.31.29434 MT, Caucasus, F-16 observer and autonomous F/A-18C recovery.

### Changes and automated checks

- Runtime: a native hook-owned event observer is installed on the sim thread,
  independently of private trigger-script globals. Its 256-event ring returns
  at most 200 per query and reports source, sourceState, oldest/latest sequence,
  historyGap and truncation. Observer registration is outside read requests.
  Each simulation epoch detaches the old observer and resets its history.
  Legacy visible mission telemetry remains a fallback. Raw exec stays disabled.
- Lua regression reproduces separate trigger/world globals, native events with
  no telemetry globals, event cursors, partial socket writes, 260-event retention,
  response truncation and detach/reset across simulation epochs.
- Site catalogue: editor guns, radar sites, searchlights, mortars and other groups
  no longer all claim SAM role. geometry and execution metadata are separate;
  source hashes and individual-heading availability are reported. Existing IDs
  and generic built-in layouts are preserved. Historical completeness is unknown.
- New typed tools: dcs_carrier_compatibility, dcs_miz_add_carrier_recovery,
  dcs_aircraft_coverage, dcs_service_date_check, dcs_miz_historical_report.
  Supplier links can be created between existing same-coalition endpoints,
  using ED's {Id,type} format and preserving opaque existing fields.
- Typecheck and build passed. Full suite with installed DCS Lua: **320 tests,
  318 passed, zero failures, two skips**. Skips: no committed native ME fixture
  corpus and no PYDCS_SRC wheel directory for data regeneration. Real stdio MCP
  tests cover new tools, historical unknowns, supplier edits and save/reopen.
  Public schema fixture now has 189 tools. Independent review found one stale
  supplier description; corrected and rechecked, with no remaining findings.

### Live results

The first run proved that merely probing mission/server globals does not expose
telemetry-loaded DCSMCP on this build. That approach was insufficient and was
replaced by the native observer fallback before claiming the issue fixed.
The first test mission also had incorrectly named JavaScript trigger fields;
those were corrected before the successful event-generation test.

The second run of runtime-authoring-r2.miz captured 25 native events, including
EventTarget-1 S_EVENT_DEAD at **t=15.801**. Runtime reported available=true,
source=hook_observer, sourceState=server. Querying afterSequence=25 returned
no duplicate event. EditorSAM's 15 units and EditorGun's four guns spawned.
This proves spawn/layout execution for these instances, not historical fidelity
or that every editor template works with Skynet.

The AI Hornet followed the newly authored Land/Landing waypoint linked to
Stennis by linkUnit/helipadId and **landed at t=246.58**. Native event:
S_EVENT_LAND, initiator=Recovery-1, place=Carrier-1, sequence=26. At t=253.83
runtime showed inAir=false, life=20, altitude 22.06 m at the carrier deck.
No user piloting or keyboard flight control was required.

A third run tested the final installed hook including historyGap/reset changes
through the actual stdio dcs_runtime_inspect tool. It returned the real death
event, source hook_observer, historyGap=false, and an empty subsequent cursor
query. The same-path bridge reload request produced no observable mission swap;
no live same-process reset claim is made. Epoch detach/reset is Lua-regression
verified. The final installed hook matches the working-tree source SHA-256:
9cf6326160f0a9f2e883e86251168c4cc61766710cd2454f3650c5c19f3c988b.

Local, uncommitted evidence is in .verification-20261118/: summary.json,
capture-*.json, recovery-*.json, mcp-live-*.json, preserved dcs-*.log and tests.log.
Successful mission SHA-256:
a9014df6af262f5ee073abb3d4303a416ee1cc14d69f4fa71c892a22324b9671.
The original installed hook was backed up before each replacement. **DCS was
terminated after testing; no DCS window remained.**

### Scope limits

Compatibility records are documented DCS pairings, not universal deck-slot or
mod support. Only the tested FA-18C/Stennis recovery is newly live-verified.
Historical bounds currently cover F-16C Block 50 and F/A-18C for USA only;
retirement, other operators and exact avionics/store fits remain unknown.
Broader aircraft reporting combines existing sourced datasets and installed
loadouts without inventing missing specs. Supplier links serialize, survive
save/reopen and load in DCS; successful physical resupply was not established.
See authoring-coverage.md for exact tool contracts and primary sources.

## Windows acceptance run — 2026-11-16

Tested checkout `c2bc179d4e9aaddbd8fd9c9fc6e5341f668c24a7` using
`docs/testing/live-acceptance`, Windows PowerShell and Node v25.6.1.
Local evidence is in `.acceptance-session-20261116/` (not committed).

- Initial installed dependencies were stale (SDK 1.29.0 and Zod 3.25.76), causing
  a TypeScript constructor error and schema fixture mismatch. After successful
  `npm.cmd ci` using the lockfile (SDK 1.32.2, Zod 4.6.7), `npm.cmd run build`
  passed and `npm.cmd test` passed **244/244, zero failures, zero skips** with
  `DCS_LUA=<DCS_INSTALL>/bin-mt/luae.exe`.
- The earlier test run during incomplete dependency installation is invalid as a
  product result; `build-final.log` and `tests-final.log` are authoritative.
- `final-package/offline-report.json` reports pass for all ten scenarios.
  `lua51-final.log` records successful compilation of all ten missions using the
  installed DCS Lua interpreter. These checks do not verify simulator behavior.
- Final package runId: `5505064f-d666-4faa-a8c6-af74ded33bc6`. All scenarios remain
  live pending. Preserve `final-package/manifest.json` and the original missions.
  Ten matching `operator-<scenario>.json` records were prepared with pending checks.
- Actual stdio MCP smoke checks discovered **143 tools**, exercised acceptance
  catalogue pagination, invalid-input rejection and subsequent recovery, and checked
  the generated SEAD archive. Full responses are in `mcp-smoke.json`.
- The live bridge responded at `127.0.0.1:8899` with `listening=true`, `phase=menu`,
  `missionEnv=false`. Runtime inspection failed with `Unknown command: runtime`.
  The installed hook differs from the checkout: installed SHA-256
  `FBE6C7F3F85616C715B3FB47D21367FD737F715124678754888768CC88D3D456`;
  checkout SHA-256 `62070859C4B411F3CB15B7792948244C83A0C5A8FACD4B619D259C92D80BAE20`.

Live acceptance is **pending**, blocked on installing the current hook and restarting
DCS, then executing the manual test plan. No missions were started or replaced,
no runtime writes were performed, and no operator or aircraft behavior checks were
marked passed. Mission Editor inspection, victory/failure and branching sorties,
carrier recovery, JTAC, logistics, pause/retry, isolated spawn/message, safe reload,
event retention and native-donor preservation still require execution and evidence.

Documentation observations: README's stated 102-tool count is stale (143 discovered).
The manual plan's `--bridge` collection option is not accepted by
`scripts/collect-acceptance.mjs`; use separate `dcs_runtime_inspect` snapshots, as
the live-acceptance README specifies.

## Live acceptance run — 2026-11-16/17 (DCS 2.9.31.29434, multithreaded)

Driven unattended: DCS was restarted into each mission from the command line
(`DCS.exe --force_disable_VR --no-launcher <file.miz>`), the briefing's FLY button
was clicked, and state was read through the bridge `runtime` command plus
dcs.log telemetry. Evidence (per-scenario `capture.json`, `dcs.log`, screenshots)
is in `.acceptance-session-20261116/live-r4|r5|r6*` (not committed). Nobody flew
the aircraft: objective/victory paths that need a pilot remain unverified.

### Defects found live and fixed (each with a regression test)

| Symptom in DCS | Cause | Fix |
|---|---|---|
| Every mission-env bridge command: `attempt to index global 'timer'` | On 2.9.31 the scripting globals live in `net.dostring_in` state `server`; `mission` is now the trigger state (probe logged per state) | Hook resolves the state holding `timer`/`coalition` (`server`, then `mission`) once per mission |
| ME `me_autobriefing.lua:493` arithmetic on nil `start_time` when pressing Fly | Authored groups lacked `start_time` (2,332/2,332 ME-saved non-static groups have it) | `start_time = 0` on new groups; `GROUP_NO_START_TIME` warning |
| Briefing `BriefingDialog.lua:372: attempt to index global 'dataBrf'` | Missing `pictureFileNameB/R/N`, `descriptionNeutralsTask` and unit `callsign`/`onboard_num`/`livery_id`/`psi` (bisected: both sets needed) | Mission template and `applyEditorAircraftDefaults` write them; numeric callsigns for Russia/Ukraine/USSR as observed |
| Player (or AI) flight starting at an airfield never spawns; spectator only | Start airfield unowned (empty warehouses) | `claimStartAirfields` gives the start airfield to the flight's side; never flips an enemy-owned one |
| Carrier/FARP start never spawns | Ship/FARP had no warehouse entry | Same helper creates the base's entry with the base's own side |
| Moskva group: both Rezky escorts HIT/KILL each other at t=0 | Ship default spacing 120 m | 1000 m (ME-saved warship groups: 863–1185 m) |
| `[DCSMCP] FRAMEWORK loaded=0` logged as ERROR in framework-free missions | No notion of expectation | INFO `expected=0`/`expected=unknown`; ERROR kept for partial loads |
| Statics reported as missing by `runtime` | `Group.getByName` never finds statics | Falls back to `StaticObject.getByName` |

Also confirmed: bundled Kutaisi parking (pydcs) matches live `Airbase:getParking()`
(58/58 slots within 1 m, same indices; new read-only hook command `parking`).
Unit `alt = 0` at a parking start is accepted (field elevation is not required).

### Scenario status (run `43c4d310` / `17f35cdd` / `77e74405`)

| Scenario | Verified live | Still needs a pilot / longer run |
|---|---|---|
| 01 SEAD | Player F-16 hot on Kutaisi parking; SA-6 + Osa alive; no false outcome | HARM attack, site kill, victory |
| 02 CAP | AWACS orbiting (climbs to ~8.2 km); 2 MiGs airborne and descending on route | Intercept/kills |
| 03 Carrier | Player F/A-18 on the Stennis deck; carrier under way | Launch, arrested recovery |
| 04 CAS/JTAC | JTAC HMMWV and T-72 targets placed and alive | F10 JTAC menu, designation |
| 05 Convoy | Ambush inactive until zone entry. Short-approach VARIANT (convoy moved 1.5 km outside the zone; not the generated mission): all 3 ambush T-72s BIRTH at t=468 on actual entry, once | Generated route is ~35 km (~3 h sim); no fire exchange observed in the following ~145 s |
| 06 Naval | Moskva + 2 Rezky alive, ~1 km apart, under way | Harpoon attack |
| 07 Branching | Escalation branch: both Reinforce T-72s BIRTH at exactly t=1200 (1,700 s real-time run); nothing fired early | Target-destroyed path and ANDed victory |
| 08 Airfield/FARP | Player on parking; 3 parked static F-16s; 2 FARPs with statics; support trucks; AI Huey cold at ServicePad | Rearm/refuel |
| 09 Logistics | Finite **empty** aircraft stock at Kutaisi denies the Player F-16 spawn (01 is the same slot with unlimited stock and spawns) | Positive-stock follow-up |
| 10 Cinematic | Briefing phase flag set; AWACS flying | Departure/update/victory phases follow player takeoff |

Not achievable unattended: synthetic LCtrl+Z did not change DCS time acceleration,
so long timelines run in real time.

## Mission design verification


This record covers DCS-MCP's Phase 4–6 working-tree additions. Package version
remains 0.2.0; nothing was published or deployed. Existing work, including the
pre-existing package-lock.json and .gitignore edits, was retained.

### Baseline and final local checks

Before these additions, `npm run check && npm test` passed: 177 tests, 172 passed,
5 DCS-dependent skips. The final Linux Node 24.22.2 run passed strict typecheck,
build and the complete suite: **206 tests, 201 passed, 0 failed, 5 skipped**.

New tests:

- `design.test.ts`: atomic configuration/calendar/weather, country transfers,
  theatre archive synchronization, explicit NavTargetPoints/drawing fields,
  goals/result compilation, stable trigger replacement, media/kneeboard preservation,
  referenced removal, deleted-file restart behavior, same-size resource snapshots,
  and dangling goal diagnostics.
- `scenario.test.ts`: all eleven scenario families; seeded mission-data/report
  equality; invalid input rejection without leaked sessions; campaign transitions
  and rollback; world-event/director script syntax; radio placeholders; symbolic
  asset keys; script syntax checked without execution; mixed SAM battery grouping
  with unchanged provenance.
- `design-server.test.ts`: actual MCP stdio discovery and calls for validation,
  generation, configuration/options, drawing, counters, single-unit activation,
  scoring, full trigger replacement, media lifecycle, current reporting, save/reopen.

Existing trigger-oracle, Lua-string fidelity, bridge, terrain, logistics, inventory,
archive safety, scene and diagnostic tests remain in the suite. No compiler
predicate definitions were added or changed. Goal/result output uses the separate
pydcs goal format and the existing compiler's condition strings.

### Reproduce

```bash
npm ci
npm run check
npm run build
npm test
npm pack --dry-run
npm run verify:design -- <new-output-directory>
```

`verify:design` generates the example interception mission, checks seeded equality
of serialized mission data, saves/reopens it, and writes a machine-readable report.
It adds one test counter after generation solely to exercise mocked runtime; the
embedded generation report remains a snapshot of the original scenario.

Optional stock Lua integration (not a DCS run):

```bash
LUA51=/path/to/lua5.1 npm run verify:design -- <another-new-directory>
LUA51=/path/to/lua5.1 npm run verify:lua51
```

Observed here with stock Lua 5.1.5 built in /tmp:

```text
LUA51_DESIGN_OK success forward events, delays, outcome, score, counter; NOT DCS verified
LUA51_DESIGN_OK success reverse events, delays, outcome, score, counter; NOT DCS verified
LUA51_DESIGN_OK failure forward events, delays, outcome, score, counter; NOT DCS verified
LUA51_DESIGN_OK failure reverse events, delays, outcome, score, counter; NOT DCS verified
LUA51_ADVANCED_OK mocked setup, proxy iteration, telemetry, and deduplication; NOT DCS verified
```

The design harness compiles the generated `trig` and `result` strings as Lua 5.1,
installs a guarded world-event handler, checks wrong-unit takeoff filtering,
actual takeoff cues, a ten-second event-relative update, success/failure arbitration
in opposite trigger orders, compiled scoring, and counter latching/rearming.
The IADS harness verifies that earlier framework setup/registry telemetry still works.
Only trusted generated fixtures and repository scripts are executed by these harnesses;
untrusted mission Lua is never executed by the authoring server.

The five DCS-dependent tests remain skipped. A stock interpreter with mocked DCS
APIs cannot establish Mission Editor compatibility or actual DCS execution.

### Artifacts and packaging

Actual proof output from this session:

```text
/tmp/dcs-p456-final-proof/mission-design-proof.miz
SHA-256: 310f29df883849b3654ea61d97ebc9f7bd8e10442e7207b4b3fe066d3f41de3a
/tmp/dcs-p456-final-proof/mission-design-verification.json
```

The JSON includes the generated mission report, deterministic check, runtime results
and artifact digest. Regenerate into a new directory; ZIP timestamps may change
archive hashes without changing deterministic mission data.

`npm pack --dry-run` passed with 245 files, including compiled modules, the example
specification and runtime/proof scripts. The Windows Node 22 workflow now also
runs `verify:design` and uploads its output with the offline acceptance artifact.
That workflow has not been run on Windows during this session.

### Remaining acceptance and explicit limits

No new feature has been opened in the DCS Mission Editor or flown. In a real DCS
installation, inspect and exercise:

1. Mission configuration, wind/cloud/fog settings, coalition briefings/bullseyes,
   NavTargetPoints, all drawing primitives/layers and forced options.
2. Briefing images and aircraft kneeboards; actual WAV/OGG decoding/playback,
   radio frequency/modulation behavior, deletion and editor resave.
3. Score goals/result evaluation and scenario outcome/time-limit behavior.
4. Single-unit-group activation, F10 check-in flags, takeoff/landing/combat event
   director cues, branches and late-activated reinforcements.
5. Existing MIST/MOOSE/Skynet ordered loading and live telemetry on generated scenes.
6. All scenario role/task/loadout/terrain combinations before describing any as flown.

Automatic casualty pickup/cargo, automatic cross-mission persistence/.cmp output,
coalition nav_points authoring, dynamic atmospheric/cyclone generation, nonzero
text rotation, every DCS predicate and moving-deck recovery are not implemented.
Installed preset/module/media behavior and radio/callsign catalogues are not inferred.
Built-in radio dialogue is fictional; source citations supplied by a client remain
unverified. Without audio, the director emits subtitles/placeholders and no audio
transmission. Shot/highlight suggestions are not recorded footage or camera control.

### Node compatibility matrix

The final strict typecheck and full suite also passed on Linux under the CI-targeted
Node versions:

| Runtime | Tests | Passed | Failed | DCS-dependent skips |
|---|---:|---:|---:|---:|
| Node 18.20.8 | 206 | 201 | 0 | 5 |
| Node 20.20.2 | 206 | 201 | 0 | 5 |
| Node 22.23.5 | 206 | 201 | 0 | 5 |
| Node 24.22.2 | 206 | 201 | 0 | 5 |

Reproduce the first three with:

```bash
npx --yes --package=node@18 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
npx --yes --package=node@20 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
npx --yes --package=node@22 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
```

These are Linux checks, not a claim that the edited Windows workflow ran.
`git diff --check` passed. Repository documentation and tool descriptions retain
DCS-MCP-native capability descriptions and implementation evidence only.

Additional regression smoke checks passed: the earlier `verify:capabilities` command
still generates and reopens its proof mission after archive/snapshot changes, and
`verify:design` also ran successfully from compiled dist modules under Node 18.
The Node 18 smoke used no Lua interpreter; the mocked Lua results above are the
separate stock Lua 5.1.5 runs.

## Bridge, security, Zod 4 and live acceptance — 2026-11-16

The baseline for this continuation was v0.2.0 at `796860b`; prior authoring work
was committed as `0ac9c15`. Baseline: npm ci/build/test passed, 206 tests,
201 passed and five DCS-interpreter tests skipped because DCS is not installed.
Open GitHub issues were queried: none were open at assessment time.

This is the single Markdown verification record. Historical records were merged
here; `docs/evidence/` is ignored and is not used as verification evidence.
All documentation filenames are lowercase. Native capability assessment is in
[capability_gap_analysis.md](capability_gap_analysis.md).

### Implemented and tested scope

- `src/security/files.ts`: same-directory temporary file, fsync, atomic publication,
  exclusive non-overwrite saves, source inode/alias protection and temporary cleanup.
- `src/security/archive-policy.ts`: declared expansion limits, duplicate/case and
  separator aliases, Windows reserved paths, ADS/control characters, suspicious
  zero-size compressed entries and invalid size metadata. The patched ZIP library
  supplies decompression safeguards; existing resources/unknown fields remain preserved.
- `src/security/transport.ts`, input-budget.ts: SDK framing at 64 MiB, collection,
  node-count and depth budgets before tool schema validation. No network listener.
- `src/bridge/client.ts`: bounded requests/responses, incremental UTF-8 decoding,
  strict envelopes, deadlines and structured BridgeError codes. The hook bounds
  pending connections, handles partial sends and reports asynchronous load errors.
- Hook `runtime` and `dcs_runtime_inspect`: read-only named groups and unit state,
  user flags/objectives, acceptance identity and event cursor/ring metadata.
  Event collection is explicitly unavailable without mission telemetry.
- `src/acceptance/`: ten missions, safe archive/geometry/trigger/Lua checks,
  detailed per-scenario manifest and operator kit; bounded, read-only source
  evidence collection into a fresh folder, SHA-256 hashes and run/outcome correlation.
  Collection never interprets screenshots or automatically proves aircraft AI.
- MCP tools: `dcs_acceptance_check`, `dcs_acceptance_generate`, `dcs_acceptance_job`,
  `dcs_acceptance_collect`, `dcs_runtime_inspect`, `dcs_tool_catalogue`.
  Generation exposes progress and permits one concurrent job, retaining twenty
  process-local jobs; job status is lost on server restart, files remain.

Tests include all ten generated missions, overwrite failure, corrupt archives,
input budgets, malformed bridge envelopes, split UTF-8, racing writers/source
aliases, synthetic evidence collection, traversal rejection, identity mismatch,
error detection and public SDK discovery. Synthetic attestation fixtures do not
constitute a DCS live result.

### Dependency and public schema review

User approved migration to Zod 4 and raising the runtime minimum to Node 20.
Dependencies: Zod 4.6.7, MCP SDK 1.32.2, adm-zip 0.6.1, patched transitive packages.
Node 18 support is removed because the patched SDK HTTP adapter requires Node 20.
The server still uses stdio; it does not expose HTTP endpoints. Windows CI now
covers Node 20/22/24, with the ten-mission acceptance kit generated on Node 22.
There is no Linux CI job. Stock Lua results below are local offline checks only.

Reviewed all 98 pre-migration tool input schemas against SDK tools/list after
migration. Names and fields are retained. Sixty were structurally equal ignoring
object-key order; 38 had representation differences. After expanding refs,
normalizing mutually exclusive discriminated unions, scalar union representations
and safe-integer bounds, 93 were equivalent. The remaining five were reviewed:

- `dcs_convert_coords`: SDK/Zod 3 had advertised an empty object for the refined
  schema; Zod 4 correctly exposes direction, coordinates, altitude and bridge
  settings. Existing runtime requirements remain; discovery is corrected.
- `dcs_miz_direct_mission`, `dcs_scenario_validate`, `dcs_scenario_generate`,
  `dcs_campaign_generate`: optional director audience and asset side now advertise
  the existing blue defaults. Their authoring behavior already defaults to blue.
- Zod 4 `.int()` rejects unsafe integers. Error wording/issue structures may change;
  clients should use the error status and actionable message rather than parsing
  Zod-specific error prose. No implicit arbitrary Lua fallback was added.

The 102 input/output schemas (126 since 0.3.0) are locked by SHA-256 regression fixtures in
`tests/fixtures/mcp-schema-sha256.json`, exercised through a real stdio SDK client.

### Reproduction and live status

```bash
npm ci
npm run build
npm test
npx tsc --noEmit
npm run check
npm audit
npm pack --dry-run
npm run verify:capabilities -- /tmp/dcs-capability-proof-new
LUA51=/path/to/lua5.1 npm run verify:lua51
LUA51=/path/to/lua5.1 npm run verify:design -- /tmp/dcs-design-proof-new
/path/to/lua5.1 tests/fixtures/hook-load.lua scripts/Hooks/dcs-mcp-hook.lua
/path/to/lua5.1 tests/fixtures/hook-runtime.lua scripts/Hooks/dcs-mcp-hook.lua
npm run acceptance:generate -- /tmp/dcs-live-kit-new
LUA51=/path/to/lua5.1 npm run acceptance:lua51 -- /tmp/dcs-live-kit-new
```

Lua compilation reparses the .miz into data-only tables and serializes trusted data
into a temporary file. It never executes package-supplied raw Lua. Stock Lua checks
execute vetted hook/setup code with mocks and compile generated trigger functions;
they do not prove DCS AI, terrain, sensor, weapon, JTAC or carrier behavior.

All ten generated scenarios are **LIVE PENDING**. Exact Windows setup, Mission
Editor/flight steps, measurable results and evidence checklist are in
[testing/live-acceptance/readme.md](testing/live-acceptance/readme.md).
Each scenario manifest includes units/positions, tasks, triggers, frequencies,
radio placeholders, objectives, special procedures, limitations and eight checks.
Separate failure/branch sorties need separate collected reports.

Remaining environment-dependent work: execute the live matrix; provide an existing
Mission Editor donor archive and verify native save/reopen preservation; supply
native positive warehouse inventories before positive stock exhaustion tests;
verify actual JTAC designation, carrier launch/arrested recovery and terrain-aware
routes. Case 09 positive-stock criteria stay blocked without a donor. Carrier
recovery is manual and requires visual evidence; a generic LAND event is insufficient.
No native .cmp campaign, complete ME trigger catalogue, authoritative offline radar
model, historical equipment database or automated CSAR pickup is claimed.

### Final local results

Linux, Node v24.22.2, stock Lua 5.1.5:

| Command | Result |
|---|---|
| npm ci | Passed; clean lockfile install |
| npm run build | Passed |
| npm test | 213 tests: 208 passed, 0 failed, 5 existing DCS-interpreter skips |
| npx tsc --noEmit; npm run check | Both passed |
| npm audit | Zero vulnerabilities (patched @hono/node-server 2.1.8) |
| npm pack --dry-run | Passed; operator documents included; no package published |
| npm run verify:capabilities | Passed; offline-only proof archive reparsed |
| LUA51=... npm run verify:lua51 | LUA51_ADVANCED_OK with mocks |
| LUA51=... npm run verify:design | Success/failure, forward/reverse mocked runtime cases passed |
| Lua 5.1 hook-load and hook-runtime harnesses | Passed; no DCS APIs executed |
| npm run acceptance:generate | Ten archives passed offline structural checks; all live pending |
| LUA51=... npm run acceptance:lua51 | Ten generated missions compiled; no DCS APIs executed |
| git diff --check; lowercase docs filename check | Passed |

The older e2e mission builder requires locally installed third-party framework
resources; its actual live/framework exercise remains an operator task. Interactive
log monitoring and hook installation are not run against a nonexistent DCS profile.
Hook installation, archive resources and framework failures have automated tests.

Continuation targets: `src/miz/flight.ts` and `src/acceptance/cases.ts` for any
carrier/flight task corrections supported by live results; `src/miz/logistics.ts`
for donor-backed inventory refinements; `src/terrain/` for sourced terrain coverage;
`src/miz/trigger-schema.ts` and authoring compiler for additional oracle-backed
predicates. Add a genuine ME donor fixture to `tests/fixtures/` only when supplied
with redistribution permission. Record live evidence using the generated kit and
update this document with observed results, never presumed behavior.

GitHub CI completed successfully for implementation commit `fab09f4`; see the completed run below.


### CI correction and Windows-only workflow

The first PR workflow run [43868581786](https://github.com/sharRahul/dcs-mcp/actions/runs/43868581786)
failed the new schema-hash test because diagnostic log-path help text embedded the
host home directory. The description now names the resolution rule without a
machine-specific path. Reviewed schema hashes were updated for that description;
the full schema assertion remains enabled. Runtime log-path resolution is unchanged.

At the user's request CI runs only on Windows. The Linux stock-Lua job was removed;
Node 22 on Windows generates and uploads the complete offline-checked acceptance
kit. Local stock Lua 5.1 checks are explicitly mock/format evidence. Actual DCS
execution remains the manual Windows acceptance stage.


### Completed GitHub CI

[Windows CI run 43868925800](https://github.com/sharRahul/dcs-mcp/actions/runs/43868925800)
completed **successfully** for `fab09f44bf936694c1c7f34b6f67fdea9b174b83`:
Node 20, 22 and 24 on Windows all passed. Node 22 also passed package inspection,
capability/design proof generation and ten-mission acceptance-kit generation.
The run uploaded `offline-capability-proof` and `live-acceptance-kit-offline-only`.
These are Windows offline test results; the five existing DCS-dependent tests remain
skipped and none of the ten scenarios is live-passed.

Branch: `feat/mission-acceptance-hardening`. Draft [PR #5](https://github.com/sharRahul/dcs-mcp/pull/5)
targets main; it is not merged. Commits include authoring/scenarios `0ac9c15`, patched
dependencies `4815772`, acceptance/bridge hardening `aa58f9c`, lowercase documentation
`8e6c65f`, CLI validation `185cda2`, and portable schema/Windows CI `fab09f4`.
This final documentation commit records those observed results. No npm package or
public release was published.

### Stock Lua 5.1 CI converted to Windows

At the user's direction, the stock Lua checks now have a dedicated Windows job,
`Lua 5.1 offline checks on Windows`; no Linux runner is configured. The job builds
Lua 5.1.5 with MSVC from the [official Lua source archive](https://www.lua.org/ftp/)
using the published SHA-256 `2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`.
`scripts/build-lua51.ps1` verifies the hash before extracting or compiling and
requires a fresh build directory. The MSVC setup action is pinned to a commit.

It runs advanced setup, design success/failure cases, hook loading, partial-write/
runtime protocol mocks and compilation of all ten acceptance missions. The stock
interpreter is set only as `LUA51`, never as `DCS_LUA`; DCS-specific tests remain
honestly skipped until DCS is installed. Its artifact is
`windows-lua51-offline-proof`. These Windows Lua checks still do not execute DCS.

[Completed Windows CI run 43869548671](https://github.com/sharRahul/dcs-mcp/actions/runs/43869548671)
passed all four jobs for `3b3b238be9a17efba42bbad7912137836095651e`: Node
20/22/24 and the dedicated Windows stock Lua 5.1 job. MSVC source compilation,
hook-load/runtime harnesses, advanced/design mocked runtime checks and ten-mission
Lua compilation all passed. The `windows-lua51-offline-proof` artifact is available
on that run. This supersedes the earlier Windows-only Node matrix evidence with
the completed Windows Lua conversion; live DCS acceptance remains pending.

## Drawings, radios, groups, weather, liveries, terrain packs — 0.3.0

```bash
npm run build && npm test          # 237 tests: 232 pass, 5 skipped (need DCS_LUA)
node --import tsx scripts/update-schema-fixture.mjs   # only after a deliberate schema change
```

`tests/gap.test.ts` covers each module with serialize -> reparse round trips; `tests/extended-server.test.ts`
drives every new tool through a real stdio client, saves, and reopens the `.miz`. The terrain-pack tests use
a synthetic stand-in for the live bridge, so they prove storage and interpolation, not DCS terrain values.
Linux local run only; no Windows CI run, Mission Editor open or flight has been performed for these additions.

`tests/hoggit.test.ts` covers the Hoggit-wiki catalogue (ids, revisions, categories, the two
page inconsistencies the generator resolves), action building and refusal, and callsign
cross-checking. Regenerate the catalogue with
`python3 -I scripts/gen-hoggit-data.py --fetch <cache-dir> data/hoggit.json` (needs
wiki.hoggitworld.com; it fetches one page at a time because the wiki answers 503 to bursts).

Airfield navaids (`data/airfield-navaids.json`) are OCR of DimOn's kneeboard images. The
generator keeps a row only when its OCR'd ATC frequencies equal pydcs's for that airfield, and
each value must pass its own range/format/colour check (`tests/hoggit.test.ts` re-asserts the
ranges). Every extracted value on Caucasus p1, Syria p1 and Persian Gulf p1 was compared by eye
with the page image: no wrong values; coverage is partial (some VOR/NDB/ILS/TACAN cells are not
extracted). Regenerate with a rapidocr virtualenv:
`ocrenv/bin/python -I scripts/gen-airfield-navaids.py <png-dir> data/airfield-radio.json data/airfield-navaids.json`.

## Inspect/edit, goals, quad zones, imported templates, payload library — 0.4.0

`tests/edit-more.test.ts` (round trips for task edits, unit edits, goals, quad zones, payload-library parsing incl.
refused non-data files) and `tests/inspect-edit-server.test.ts` (stdio: import a site from a saved .miz, place it
rotated, edit its tasks, set airbase ownership). Offline only; the payload tests use a synthetic UnitPayloads file.

## Fuel, radio bands, provenance, donors, native fixtures, compatibility — 0.5.0

- `tests/quality.test.ts`, `tests/quality-server.test.ts`: fuel limits/percent/audit, documented radio bands and RADIO_*
  validator codes, donor harvest/import/add-stock (synthetic donor; no ME-saved warehouse was available).
- `tests/provenance.test.ts`: every dataset registered and pinned; with `PYDCS_SRC` set (CI job `provenance`), the five
  pydcs-derived files regenerate byte-for-byte from the sha256-pinned pydcs 1.0.0 wheel.
- `tests/native.test.ts`: the native-fixture suite, proven on a self-made mission; no ME-saved fixture committed yet.
- `tests/compat.test.ts`: all 12 theatres with parking starts, all 170 aircraft, 361 vehicle, 57 ship and every
  non-heliport static type, all site templates, drawing kinds and catalogued options; editor fix-ups in the CI Lua job.

## Install-derived data, live sampling and validator calibration — 2026-11-17 (0.6.0)

Offline work on a machine with DCS 2.9.31.29434 installed (`<DCS_INSTALL>`) and 193
community/editor-saved missions under `Saved Games/DCS/Missions`. `npm run build` and
`npm test` pass (270 pass, 0 fail, 8 skipped — the skips need DCS_LUA/PYDCS_SRC or a
running sim). Nothing in this section is simulator-verified.

**Verified against real data on this machine (not against the simulator):**

- ED's own `Mods/terrains/<t>/radio.lua` and `beacons.lua` parse for all 12 installed
  terrains, including the two with no bundled data (Iraq: 20 airfields, 43 beacons;
  Marianas WWII). Spot-check: Incirlik reports TACAN channel 21 "DAN" and ILS 109.3 MHz,
  which match the airfield's published values.
- `dcs_install_report` reads build `2.9.31.29434` and install date from `autoupdate.cfg`,
  finds the non-default install root from the `Command line:` entry in dcs.log, and names
  Iraq and Marianas WWII as installed-without-bundled-data plus 5 declared type ids the
  pinned catalogue lacks.
- `data/me-icons.json` holds 53 icons, the full Mission-Editor picker list. ME-saved
  missions in the corpus confirm the drawing format it feeds (`primitiveType = "Icon"`,
  bare `file = "P91000006.png"`, `scale`).
- The hook (including the four new mission-environment commands) loads and runs under
  DCS's own `luae.exe`, and every injected snippet now compiles and executes against
  stubbed DCS APIs in `tests/fixtures/hook-load.lua` (`SNIPPET_FAILURES 0`).

**Validator calibration.** 184 of the 193 missions opened (the other nine are RAR archives
renamed `.miz`, which DCS cannot open either). Before this change the validator reported
400+ ERRORs on them; every one was a false positive from stale pydcs data or from treating
editor-tolerated sloppiness as fatal. After recalibration the corpus reports **zero ERRORs**,
with warnings: AIRCRAFT_TASK_UNSUPPORTED 691, PAYLOAD_NOT_CATALOGUED 502, UNKNOWN_UNIT_TYPE
267, PAYLOAD_LIMIT 265, COUNTRY_TYPE_NOT_OFFERED 135, PARKING_SLOT_MISSING 86,
DUP_UNIT_NAME 65, GROUP_NO_START_TIME 30, TASK_REFERENCE_MISSING 4, TRIGGER_GROUP_MISSING 2,
AIRFIELD_REFERENCE_UNKNOWN 1, PARKING_CONFLICT 1, GOAL_REFERENCE_MISSING 1.

**Still pending in DCS:** an airbase pack built from a running mission and a parking start
at an airfield that came from it; a train opening in the Mission Editor and running on its
rails; a troop lift loading and unloading; an icon drawing on the F10 map; `roads`,
`clearspot` and `los` answers compared with what the editor shows. No existing SAM-template
provenance or DCS-runtime claim was promoted by this work.

---

## 2026-11-17 (0.6.1) — mission-corpus sweep: triggers, campaigns, compounds

Offline. Two reproducible sweeps over every Mission-Editor-saved mission on this machine: the
user's `GS Missions`, `Evangelic Missions` and `Rodz88 Missions` folders, the rest of
`Saved Games/DCS/Missions`, and every mission DCS ships under `Mods/aircraft`, `Mods/campaigns`
and `Mods/terrains`. Folders this project writes into are excluded from both, so the corpus is
independent of our own output.

### Trigger compiler against DCS's own output

`node --import tsx scripts/sweep-triggers.ts <folders>`

| | |
|---|---|
| missions read | 3024 |
| trigrules seen | 39025 |
| recompiled by us | 29023 |
| left untouched (no compiler) | 10002 |
| compiled strings compared | 58046 |
| **identical to what DCS wrote** | **55842 (96.2%)** |

The 3.8% that differ are all one thing: the editor writes two forms for a handful of actions
given rules whose fields are identical — `a_out_text_delay` / `a_out_sound` with and without
their trailing delay, `a_radio_transmission` with 11 or 12 arguments, `a_explosion_marker` with
3 or 4. We emit the corpus-majority form. No mismatch involves an argument in the wrong position
or a value we invented.

Oracle fixture: **66 predicates, 41 whole triggers, all four trigger types** (was 45 / 36 / one
type after the last regeneration). Added and byte-matched: 10 conditions
(`c_group_alive`, `c_unit_damaged`, `c_all_of_group_in_zone`, `c_part_of_group_out_zone`,
`c_unit_in_zone_unit`, `c_unit_altitude_higher`, `c_unit_altitude_higher_AGL`,
`c_unit_altitude_lower`, `c_missile_in_zone`, `c_bomb_in_zone`), 11 actions (`a_explosion_unit`,
`a_explosion_marker`, `a_explosion_marker_unit`, `a_signal_flare_unit`, `a_out_picture_s`,
`a_mark_to_all`, `a_add_radio_item_for_coalition`, `a_set_ATC_silent_mode`, `a_shelling_zone`,
`a_zone_increment_resize`, `a_ai_task`) and the `or` condition separator.

**Correction to a previous claim.** This file and CLAUDE.md both stated that `a_out_text_delay_g`
takes four arguments with no `start_delay`. It takes five in the great majority of editor-saved
missions; the four-argument form exists but is the minority. `message_to_group` therefore accepts
`delaySeconds` now. The earlier statement came from a narrower sample.

### Validator against the same corpus

`node --import tsx scripts/sweep-validator.ts <folders>`

| | |
|---|---|
| missions validated | 3023 |
| unreadable (RAR renamed `.miz`, or an oversized embedded track) | 17 |
| **ERRORs** | **0** |

Two codes were demoted after they fired on missions DCS itself ships and flies:
`TASK_WAYPOINT_MISSING` (195 occurrences, a task naming a waypoint that was later deleted) and
`DUP_UNIT_ID` (120). Both are warnings whose messages say that DCS's own missions do this.

Warning tally over the full corpus: AIRCRAFT_TASK_UNSUPPORTED 11553, PAYLOAD_NOT_CATALOGUED 4273,
PAYLOAD_LIMIT 3858, UNKNOWN_UNIT_TYPE 3446, AIRFIELD_REFERENCE_UNKNOWN 1125,
PARKING_SLOT_MISSING 890, COUNTRY_TYPE_NOT_OFFERED 704, PARKING_CONFLICT 250, DUP_UNIT_NAME 246,
TASK_WAYPOINT_MISSING 195, TASK_REFERENCE_MISSING 132, DUP_UNIT_ID 120, TRIGGER_GROUP_MISSING 11,
RADIO_UNKNOWN 10, RADIO_UNKNOWN_CHANNEL 10, GOAL_REFERENCE_MISSING 7, GROUP_NO_START_TIME 1. The
large counts are the pinned pydcs catalogue being older than the installed DCS, not mission faults.

### Campaign files

All **64** `.cmp` files DCS ships parse as data, validate with **zero findings**, and round-trip
through our own table builder with identical stages and intervals. `stepCampaign` reproduces ED's
`chooseNextMission` on them. The format and the rules are ED's own installed Lua read as text, so
they are first-party; nothing written by this project has been RUN by DCS as a campaign.

### Compound footprints

Clustering 5101 statics across the three user folders at 60 m single linkage found 233 clusters,
130 of them distinct, from 4 to 69 objects (a HESCO-walled Scud site, sandbagged outposts,
revetment lines, vehicle parks). One was imported and placed in a fresh mission: offsets
round-tripped to 0.000000 m and all 17 objects kept their individual headings. Provenance stays
`imported` — measured from a user-supplied file, never flown, never opened in the Mission Editor,
and never shipped with this server.

### Still unverified in DCS

A written `.cmp` played through two stages and branching on score; an imported compound opened in
the Mission Editor; a reactive spawn firing in flight on zone entry and on group-dead; `big_smoke`
at each preset; an `a_ai_task` push moving an AI group; `a_mark_to_all` on the F10 map;
`a_out_picture_s` displaying; `dynSpawnTemplate = true` producing a usable dynamic slot (not
claimed anywhere).

---

## 2026-11-17 (0.6.2) — first live DCS run of the 0.6.x work, and a bug it found

DCS 2.9.31, Persian Gulf, started cold straight into a purpose-built mission:

```
node scripts/build-verify-mission.mjs [outPath] [--learned-type=<id>]
"<DCS_INSTALL>\bin\DCS.exe" --force_disable_VR --no-launcher <the .miz>
```

The mission (`scripts/build-verify-mission.mjs`) carries eleven of the things that had
never been near DCS: a reactive wave on zone entry, a second on `group_dead` with a
20 s delay, an `a_ai_task` push, `a_mark_to_all`, `big_smoke` at presets 1-8, a train,
a troop lift, an editor icon drawing, a built-in SA-2 site, a learned mod type, and MIST +
MOOSE + telemetry loaded in order from one start trigger.

### The bug: `DisembarkFromTransport` does not exist as far as DCS is concerned

```
ERROR WORLDGENERAL (Main): "ComboTask" unable to create task "DisembarkFromTransport"
```

Hoggit documents `DisembarkFromTransport(x, y, zoneRadius)`, and that is what
`src/miz/transport.ts` wrote. DCS refuses it and drops the task, so a troop lift built this
way would fly to the drop point and never unload — silently, because the error is in
dcs.log and nowhere else.

A sweep of every editor-saved mission on the machine then settled what the right task is:

| task id | occurrences |
|---|---|
| `EmbarkToTransport` | 75 |
| `Embarking` | 68 |
| **`Disembarking`** | **58** |
| `CargoTransportation` | 1 |
| `DisembarkFromTransport` | 1 (only the mission this test built) |

`Disembarking` takes `{ x, y, groupsForEmbarking = { 1 = <groupId> } }` and no radius, and
it appears in missions DCS itself ships. `transport.ts` now writes that, and
`tests/raw-transport.test.ts` asserts both the new task AND the absence of the old one.
This is the Hoggit-documents-the-scripting-API / the-editor-writes-something-else split,
caught the only way it can be: by loading the file in DCS.

### Verified live

| what | result |
|---|---|
| hook loads on this build | `DCS-MCP: hook server listening on 127.0.0.1:8899`, GUI poll registered, `Loaded ...dcs-mcp-hook.lua`, no adjacent ERROR |
| a dcs-mcp-authored mission loads | `loadMission Done: Control passed to the player`; no mission-specific error other than the one above |
| scripting-state probe | `state=server -> timer=table,coalition=table,env=table,trigger=table`; `state=mission -> a_do_script=function, timer=nil`. The 0.6.0 finding holds on this build. |
| `land` (`dcs_check_terrain`) | 5 points, heights and surfaces; it caught the test mission's own troop pickup sitting on WATER at (60520, -299020), which was then moved |
| `roads` kind=roads | nearest road point 15.4 km from the SA-2, with height and surface |
| `roads` kind=railroads | nearest rail 157-173 km away — the Persian Gulf has rails only in one corner, so the train in this mission is NOT on a railway. The limitation documented for `addTrain` is real and this is how to fix it. |
| `roads` rail path | `findPathOnRoads` returned a path |
| `los` | `isVisible` true over 46.6 km, with the geometry-only note |
| `clearspot` | 37 clear spots in a 400 m radius, slopes 6.4-7.8 deg, scenery search ran (0 objects) |
| `airbases` | 30 airbases with runways and parking |
| `dcs_airbase_build_pack` | pack of 30 Persian Gulf airbases built from the running mission; `packAirports` serves them with `slotsUnverified` |
| terrain pack vs `dcs_check_terrain` | 9x9 pack at 250 m; pack says height 27.91 / surface 1 at the SA-2, DCS says 27.9126186 / surface 1. **Match.** (0.3.0 pending item closed.) |
| one start trigger, ordered script load | telemetry `BOOT t=0`, `FRAMEWORK MIST loaded=1 version=4.5.125`, `FRAMEWORK MOOSE loaded=1`, `READY telemetry=1` |
| learned mod type | `Su-35S`, learned from the mission corpus, was accepted as a type id by DCS — it got as far as loading the model, then reported `Corrupt damage model`, which is the Su-35 mod's own state on this install, not a dcs-mcp fault |
| `big_smoke`, train, icon drawing, SA-2 site, reactive triggers | all loaded with no complaint from DCS; the file format is accepted |

### Two corrections the live data forced

- **`termType` is not pydcs's `flags`.** The live parking answer DOES include a category
  field, which the pack docs said it did not. But sampling Bandar Abbas gave termType
  104/72/16 where the bundled pydcs slots for the same airfield carry flags 6/4, so the two
  are different enums. `termType` is kept in the pack and never mapped onto `flags`.
- **Term_Index_0 comes back as -1** when a slot has none, so the pack was writing `"-1"` as
  a `parking_id` — a slot name no airfield has. It now falls back to the terminal index.

### Still not verified, and why

The sim sits at the briefing until FLY is clicked, and synthetic keys do not reach DCS, so
nothing that needs the mission to actually RUN was reached: the reactive waves firing,
`a_ai_task` moving a flight, `a_mark_to_all` on the F10 map, the troop lift loading and
unloading, the train moving on its rails, `big_smoke` rendering per preset. `net.load_mission`
through the bridge also did nothing from that paused state — same no-op class as from the
cold menu, now seen one step further in.

Everything above needs a human to click FLY in
`Saved Games/DCS/Missions/VS Code Missions/dcs-mcp-verify-0-6b.miz` and watch dcs.log:
every trigger in it calls `DCSMCP.trig`, so a trigger that fired and a trigger that fired
into a broken action are distinguishable.

Also still unverified: a `.cmp` played through two stages (needs the campaign UI), an
imported compound opened in the Mission Editor, SAM provenance promotions beyond SA-2.

---

## 2026-11-17 (0.6.3), second live run — a flown sortie in `dcs-mcp-verify-0-6b.miz`

The 0.6.2 run above got as far as the briefing and no further. This one was flown: the
player took a shot at the SA-2 (`S_EVENT_SHOT` t=296, `S_EVENT_HIT` on
`SAM-SA2-Verify-1` t=309) and ended the mission at t=322. So for the first time the
in-flight half of the mission ran.

DCS 2.9.31.29434 MT, Persian Gulf, started with
`DCS.exe --force_disable_VR --no-launcher dcs-mcp-verify-0-6b.miz`. Bridge reported
`phase=running missionEnv=true simTicking=true mission=dcs-mcp-verify-0-6b`.

### Newly verified

| what | evidence |
|---|---|
| **`Disembarking` is the right task** | zero `ComboTask` errors in the whole log, where the 0.6.2 run had `unable to create task "DisembarkFromTransport"`. The 0.6.2 bug is closed. |
| **reactive spawn on zone entry fires, and its actions run** | `[DCSMCP] TRIG t=38 name=WAVE1` — the trigger fired AND its DO SCRIPT action executed. The `coalition_in_zone` predicate, the flag, and `a_activate_group` all work. |
| **`a_activate_group` really activates** | `Wave1-Armour` went from `active=false` to shooting: `SHOOTING_START`/`HIT`/`KILL` against the troop group from t=47, and it shot the UH-1H down at t=60. A late-activated group becomes a live, AI-driven group. |
| **late activation reads correctly before the trigger** | at t=7.9 both waves existed in `coalition.getGroups` with `active=false`; `Group.getByName` finds them, `Unit:isActive()` is the field that matters. Presence in a unit list is not evidence a late-activated group has spawned. |
| **`DCSMCP` is reachable from the trigger state** | the `TRIG` line proves the telemetry table a start trigger created is visible to a later trigger's DO SCRIPT. |

### The train does not spawn at all — and nothing says so

`Verify-Train` was **absent from the running mission**: our own `Group.getByName` returned
`exists=false`, MOOSE's database registered every other group and not this one, and
`dcs.log` does not contain the string "train" anywhere. The group is correctly written in
the file (groupId 13 under Russia's `vehicle` list, one `Train` unit, `wagons = {}`,
`type`/`action` `"On Railroads"`).

The cause is the documented limitation, biting silently: measured live with
`dcs_terrain_roads kind=railroads`, the nearest railroad to the train's two route points is
**173 km and 157 km away**. DCS drops an `On Railroads` group that has no track under it,
and logs nothing at all.

So the limitation is not cosmetic. `addTrain` without rail-snapped points produces a group
that does not exist in the mission, with no error anywhere. `build-verify-mission.mjs` now
places the train on the ends of a real 190-point `findPathOnRoads kind=railroads` path on
the Persian Gulf's only railway.

### `big_smoke` statics are not scriptable objects

MOOSE reported all eight: `Static object Smoke-P1..P8 does not exist!` and
`(Alive) = false`, while registering every other object in the mission. Nothing in dcs.log
complains about them and the mission loads clean, so this is consistent with an effect
object that renders without being retrievable as a `StaticObject` — but that is an
inference, not a measurement. Whether the smoke columns actually render still needs a human
to look at them, and `StaticObject.getByName` is not the way to check.

### Fixed: `dcs_get_self_data` crashed the first time a player was in a cockpit

```
[string "local function enc(v)..."]:37: attempt to index local 'pby' (a number value)
```

`LoGetADIPitchBankYaw()` returns **three values, not a table**. The hook did
`local pby = LoGetADIPitchBankYaw() or {}`, which captured the pitch number, and `pby[1]`
then raised the error above. Every earlier run stopped at the briefing, so the export-state
path had never been exercised. Fixed in `scripts/Hooks/dcs-mcp-hook.lua` (`handlers.self`);
8/8 hook tests pass under `luae.exe`. The fix needs a DCS restart to be exercised live.

### `eventMonitoring.available=false` while the events are in the log

`dcs_runtime_inspect` reported `eventMonitoring: { available: false }` throughout, while
dcs.log carried 24 `[DCSMCP] EVT` lines from the same mission, and the `TRIG` line proves
the telemetry table exists. The hook resolves `runIn("mission", …)` to state `server` on
this build (0.6.0 finding, unchanged), and the mission scripts were loaded by
`a_do_script` into the trigger state. The two states do not share globals, so the hook
cannot see `DCSMCP`. This reproduces the same symptom the acceptance round recorded, now
with positive proof that the table is present and reachable from triggers. Not fixed: the
right fix is to decide which state the probe should look in, and that needs its own
investigation rather than a guess.

### A flaw in the test mission itself

`Wave1-Armour` was placed at (65256, -250053) — exactly the troop lift's pickup waypoint,
25 m from the soldiers, with the drop waypoint on the SA-2 site. The wave activated as
designed and then killed three of the four soldiers and shot the helicopter down at t=60,
so the troop lift could never be observed. The wave is now at (70000, -256000) — 7.6 km
away, LAND, slope 0.4 deg, no scenery, all checked live — and the drop is at
(66000, -246500), LAND at 34.4 m. A reactive wave must not spawn on top of another thing
the mission is testing.

### Still unverified after this run

`WAVE2` never fired: the SA-2 took one hit and the mission ended before the site died. So
the `group_dead` reactive wave, its 20 s flag delay, and the `a_ai_task` push on
`Wave2-CAP` remain untested, as do `a_mark_to_all` on the F10 map, the icon drawing, the
eight smoke presets rendering, the train moving on its rails, and the troop lift loading
and unloading. `dcs-mcp-verify-0-6c.miz` (sha256 53dfc518…) carries the fixes and is what
the next sortie should fly, pressing the attack until every launcher of the SA-2 is dead.
