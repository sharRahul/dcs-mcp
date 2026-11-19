# Scenario examples

These self-contained version-1 JSON specifications use the existing scenario engine.
They require no external Lua framework, voice pack or other file. Aircraft module
ownership is still required for the chosen player slot. These are fictional,
modern Caucasus training designs with explicit stores, support, event cues and
observable outcome conditions.

| File | Player / duration | Progression and objective |
| --- | --- | --- |
| [interception.json](interception.json) — Northern Watch | F/A-18C two-ship / 40 min | Hot Kutaisi departure; intercept two Su-24M strike aircraft; MiGs activate 90 seconds after takeoff. Protect Defenders. AWACS and probe-and-drogue tanker support. |
| [sead-strike.json](sead-strike.json) — Copper Corridor | F-16C two-ship / 50 min | Destroy the SA-6 tracking radar; 20 seconds later the allied Hornet strike activates against Logistics. MiGs scramble 45 seconds after strike release. Both target objectives are required. |
| [convoy-escort.json](convoy-escort.json) — River Road | F/A-18C / 50 min | Checkpoint entry activates a BMP ambush; armour follows after 90 seconds. Get surviving convoy units to Destination and destroy both hostile groups. Protect cargo truck Convoy-2. |
| [carrier-defense.json](carrier-defense.json) — Blue Water Shield | F/A-18C on stock Stennis / 50 min | Protect a moving carrier and escort from two armed Su-24M naval-strike waves. Wave two activates at 300 seconds. Destroy both raid groups after that release; protect Carrier-1. |
| [ground-attack-base.json](ground-attack-base.json) — Iron Gate | F/A-18C two-ship / 60 min | Destroy command, logistics and armour groups at a fictional military compound, then reach Egress Gate. Allied F-16 SEAD support, Osa/Shilka defences and a delayed fighter scramble. Protect Ranger-1. |
| [cas-a10c.json](cas-a10c.json) — Valley Shield | A-10C II two-ship / 50 min | Defend friendly armour; destroy an advancing tank group, artillery vehicle park and BMP reserves released 90 seconds after Battle Area entry. Egress required. |
| [cas-su25t.json](cas-su25t.json) — River Relief | Su-25T two-ship / 50 min | Clear a Bradley roadblock and supply trucks. The roadblock kill releases an Abrams counterattack after 60 seconds. Fictional Russia-blue/USA-red assignment; protect friendly armour and egress. |
| [cas-apache.json](cas-apache.json) — Dust Escort | AH-64D Apache / 40 min | Hot FARP start; escort trucks to Protected Destination, destroy BMP/supply groups and defeat a tank reserve released 30 seconds after Battle Area entry. Egress required. |
| [cas-ka50.json](cas-ka50.json) — Black Shark Counterbattery | Ka-50 III / 40 min | Cold FARP start; destroy an M109 artillery park, supply trucks and a Bradley reserve released 45 seconds after supply destruction. Protect Forward Pad and egress. |

## Generate and revise

1. Read the selected JSON, including its briefing and assumptions. Pass its contents
   as the specification argument to dcs_scenario_validate.
2. Pass the same specification to dcs_scenario_generate, then save the returned
   session with dcs_miz_save_as to a new .miz path. These tools accept parsed JSON,
   not a filename.
3. Inspect the generation report, terrain, routes and module-specific loadouts.
   Edit a copy of the JSON or the mission session; regenerate or save as a new file.
4. For durable revisions and flight evidence, read dcs://skills/mission-production,
   create a production project with explicit checks, and pass the JSON to
   dcs_production_generate. Use scenario_outcome criteria rather than guessing
   generated outcome flag numbers.

After npm ci and npm run build, run:

    node --import tsx --test tests/scenario-examples.test.ts

This generates every example twice, checks identical mission data and catalogued
store stations, saves/reopens each mission, checks its validator report and parses
its generated Lua as 5.1. With DCS Lua available, it also exercises phase gates,
protected-asset failure and outcome arbitration in both trigger orders against
mocked APIs. The CI Lua 5.1 job runs these same phase checks using stock Lua.

## Reading the examples

- Positions and route points use DCS metres (x north, y east); aircraft route
  altitudes are MSL and speeds are m/s. Frequencies are MHz. Internal fuel is kg.
- The force named by player.group gets one Player slot; its other aircraft are AI.
  No group is silently converted into a multiplayer package.
- lateActivation declares inactive reinforcements. Director effects activate
  them after a condition or delay. A detection phase is only the declared trigger
  cue, not an implementation of radar detection.
- Victory lists are AND conditions. Failure lists explicitly use an or separator
  where either player loss or a protected-asset failure should fail the objective.
  Flags 30, 31, 35 and 50 are example-owned phase/failure flags; the engine allocates
  its own flags around existing references.
- Director messages describe observed conditions or scenario cues; final scoring
  is controlled by the outcome arbiter. Failure wins simultaneous candidates in
  its one-second window. A subtitle is not the final score.
- No example automatically ends DCS on success/failure. A landing-event cue does
  not prove which airfield/carrier was used. Automatic landing routes, deck-slot
  planning, carrier radio aids and qualitative recovery checks are not configured.

## Close air support and helicopter notes

The CAS examples require deliberate friendly/hostile identification and player
weapon employment. They do not provide a real JTAC/FAC, nine-line, laser code,
external designation or AI crew setup. The initial group task points at Primary
Targets only; the other target groups must be selected separately. Stationary
artillery vehicles are targets, not scripted bombardment batteries.

A-10C II carries Mavericks/JDAMs and a targeting pod; Su-25T uses Vikhr/Kh-25ML.
Apache carries eight laser Hellfires and rocket pods; Ka-50 III carries twelve
Vikhr and rocket pods. Compatible station identifiers do not prove guidance,
visibility, AI employment or balanced combat.

Helicopter examples use linked FARP starts but configure no resupply service.
Their route altitudes are 1500 metres MSL, not terrain following. Check pad
placement, obstacles, weight and route clearance when changing the design. The Apache convoy
arrival condition counts surviving trucks; Protected-1 is separately mandatory.
Ka-50 instead protects the Forward Pad static unit itself.

See [ground sites and movement](../../docs/ground-sites.md) for compound presets,
boundaries, convoy/combat route transitions and prepared Germany site candidates.

## Verification scope

Native DCS functional checks and their exact scope are recorded in
[the verification record](../../docs/verification.md). Combat success depends on
pilot decisions and is not the functional acceptance criterion. Store station
compatibility does not establish weapon effectiveness, mission balance or every
AI combat decision. Transport convoys use native On Road actions; advancing combat groups use
native Rank (line abreast) plans. River Road uses points sampled from the native
road graph. Formation changes are authored rather than automatic reactions to
enemy contact. Changes to positions, routes,
modules or the simulator version require fresh terrain and execution checks.

Iron Gate represents its base with military vehicle groups, not buildings or static
objects. Only Base Command is the initial AI AttackGroup task; the player must
prosecute Logistics and Armour separately. Ranger-1 is friendly, not a JTAC.

Carrier victory counts aircraft, not launched missiles; missiles may still be in
flight when victory latches. Extend the success conditions/adjudication for a mission
that must track those weapons. Stock Stennis avoids an explicit Supercarrier unit;
module-specific deck operations still need DCS verification.
