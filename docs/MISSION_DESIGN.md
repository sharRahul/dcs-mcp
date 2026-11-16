# Mission design, scenarios and cinematic direction

DCS-MCP authors standard mission tables and assets locally. No external AI API or
text-to-speech subscription is required. An MCP client can reason about a mission,
submit its specification, and receive a generated mission session plus an independent
validation report. All new behavior is **offline tested; not DCS-verified**.

## Mission configuration

`dcs_miz_configure_mission` applies a validated, atomic patch:

- Canonical theatre selection for an empty mission. It refuses to migrate placed
  units, zones or drawings. Save also updates the separate `theatre` archive member.
- Country assignments through the existing DCS catalogue; duplicate/opposing
  assignments fail. `dcs_miz_assign_country` explicitly transfers an entire country
  and its groups, updating both coalition representations. It preserves existing
  references, so review coalition-specific triggers, tasks and warehouse ownership.
- Calendar date (including leap-year validation), time in seconds after midnight,
  temperature, QNH in mmHg, wind at ground/2000/8000 metres, clouds, visibility,
  turbulence, fog and dust. Wind speed is m/s and direction is degrees.
- Mission title/general briefing, coalition briefing text, bullseyes and forced
  options/restrictions. Existing `dcs_miz_set_mission_options` remains available.

Season follows the mission date; there is no invented season enum. Temperature is
explicit. Static weather fields are authored; dynamic atmospheric/cyclone generation
is not implemented. Installed cloud-preset availability is unknown: `PresetN` strings
are structural identifiers, not a guarantee the installed DCS recognizes a preset.
Pass `preset:null` to remove an existing preset before supplying manual cloud values.
Unknown weather fields remain unchanged.

`dcs_miz_add_reference_point` writes aircraft `NavTargetPoints` with x/y, index and
text_comment. F-14/JF-17 comments have module-specific meanings; other modules can
ignore them. General navigation uses existing route/waypoint tools. Existing
coalition `nav_points` are preserved; their schema is not guessed.

## Triggers, flags and scoring

`dcs_miz_trigger_capabilities` lists the exact compiler scope. Existing start/once/
continuous/change types, messages by coalition/group/unit/country, flag comparisons,
counters/timing conditions, zone/life/death tests, F10 menus, radio transmissions,
sounds, script actions and activation/deactivation remain available. Unknown imported
predicates keep their existing compiled representation; unsupported new predicates
are refused. This does not claim every predicate shipped by DCS is implemented.

The original trigger oracle and compiler are retained. New helpers reuse it:

- `dcs_miz_replace_trigger` replaces type/conditions/actions at a stable 1-based
  index, recompiling both `trigrules` and `trig`. It refuses opaque custom runtime
  data at the target slot. Existing removal/type/comment tools remain available.
- `dcs_miz_add_counter` compiles an existing do_script action using public
  getUserFlag/setUserFlag APIs. `change` counts false-to-true edges; `once` counts
  once. No fictitious DCS increment predicate is introduced.
- `dcs_miz_add_unit_activation` resolves a unit to a **single-unit non-static group**.
  DCS activation is group-scoped, so multi-unit groups are refused. Use separate
  groups for independent units. Activation requires lateActivation=true.
- `dcs_miz_add_goal` writes the `goals` table and compiled `result` conditions,
  actions and functions following pydcs's score-goal format. Conditions come from
  the existing compiler. It preserves unrelated goals/results. Scoring is separate
  from `end_mission`. Validation diagnoses known goal references after deletion.

New scenario/director script actions and script assets are parsed as Lua 5.1 for
syntax, never executed on the server. Syntactic validity does not prove DCS APIs or
third-party framework behavior. Existing MIST/MOOSE/Skynet load tools and the ordered
single load trigger remain available; scripting frameworks are not bundled or faked.

## F10 drawings

`dcs_miz_add_drawing` supports line/polyline, circle, polygon and text. These cover
operational boundaries, target areas, labels and waypoint annotations. The existing
threat-ring helper remains available. Origins and vertices use absolute DCS metres
(x=north, y=east); serialized vertices are relative to mapX/mapY.

Shapes use DCS's Line/Polygon/TextBox primitives, lineMode/polygonMode and RGBA color
strings. Only Red, Blue, Neutral, Common and Author layers are created. Red/Blue/
Neutral layers carry the corresponding DCS audience intent; actual in-game visibility
also depends on mission F10 options and observer roles. Existing objects/options are
preserved. There is no assertion that a drawing has been displayed in DCS.

## Assets and resource lifecycle

`dcs_miz_embed_asset` accepts a local file and kind:

| Kind | Representation |
|---|---|
| audio | WAV/OGG under l10n/DEFAULT with mapResource key |
| briefing_image | PNG/JPEG resource key appended to the selected coalition picture list |
| kneeboard | KNEEBOARD/<aircraft-id>/IMAGES/<filename>, applying to all aircraft of that type |
| script | Lua 5.1 syntax-checked .lua resource; not automatically executed |
| media | Uninterpreted mission-specific resource |

`dcs_miz_list_assets` shows the effective archive inventory, including pending changes.
`dcs_miz_remove_asset` removes a selected file and its resource keys. Known references
in mission tables block removal unless forced; references inside opaque scripts/media
cannot be proven absent. Forced removal reports remaining references requiring repair.
Different bytes never silently replace an existing asset at the same path.

Names/paths and size limits use the existing archive policy. Unrelated members remain.
Pending kneeboard files and deletions persist through snapshots, save/reopen and
restart. Removed files are pruned from snapshot resource folders so they cannot be
resurrected. Final output is checked against archive limits before writing.
Extensions are validated, but image/audio decoding is not verified; embedding bytes
is not a claim of playable voice or a displayed image.

## Structured scenario generation

See [examples/scenarios/interception.json](../examples/scenarios/interception.json)
for a complete client-supplied specification. It is a design example, not a
terrain-cleared or flown mission. It intentionally asks the author to choose a
validated combat loadout.

Use `dcs_scenario_validate` first to compile into a disposable session and return
errors/report without retaining a mission. `dcs_scenario_generate` performs the
same checks and keeps the resulting editable session. Save with `dcs_miz_save_as`.

Specifications include:

- Version/name/scenario kind, canonical theatre and optional integer seed.
- Coalitions/countries, player group and Player/Client slot, objective.
- Explicit force types, roles, counts, positions, starts, routes, loadouts,
  frequencies, late activation, optional bounded position jitter and support names.
  Surface forces can use explicit mixed compositions or a SAM/EWR site template;
  the lead type must match the first composition type. Batteries remain one group
  and retain their existing provenance. Compositions override count, as in the
  low-level API; mixed groups are capped at 100 units, scenarios at 5000.
- Difficulty, declared threat level, duration, date/time/weather/configuration.
- Zones, supported triggered events, victory/failure conditions, optional director.
- Optional assets with stable ids, filenames and canonical base64 content; maximum
  32 MiB total. Actions/director audio can use `asset:<id>` instead of predicting a
  generated resource key. Large media can instead be embedded after generation.
- Author-supplied assumptions and warnings in the generated report.

Aircraft/type/role/country constraints, unique names, force target/start dependencies,
required friendly AWACS/tanker supports, zone/resource references and final mission
validation are checked independently of the AI client. Unresolved/cyclic dependencies
fail without leaving partial sessions. No force types are silently substituted.

Supported scenario families and boundaries:

| Family | Generated behavior / limit |
|---|---|
| Interception | Player intercept role with a declared opposing aircraft target |
| Defensive/offensive counter-air | CAP/intercept/strike role requirements and opposing aircraft |
| SEAD/DEAD | Existing supported role tasking against declared forces; no automatic weapon choice |
| CAS/strike | Group-target tasking and explicit objectives/conditions |
| CSAR | Helicopter transport with zone/flag objectives; no automatic casualty pickup/cargo implementation |
| Convoy escort | Moving friendly ground force plus player mission and objective triggers |
| Naval strike | Antiship Strike task with an opposing ship target |
| Carrier operations | Existing ship-linked departure starts; no moving-deck recovery validation |
| Multi-stage campaign | Validated mission sessions plus an acyclic outcome transition manifest |

All force placement is explicit. Optional jitter uses a local seeded PRNG and consumes
randomness in declaration order. This seed does not make DCS AI or runtime random triggers deterministic. Identical input/seed produces identical mission
**data**, including generated tasks/flags/report. ZIP timestamps and session ids are
not a promise of identical archive bytes. Difficulty sets default AI skills when not
explicit; threat level is a declaration checked for obvious inconsistencies, not an
authoritative tactical difficulty model. Terrain is not invented or implicitly checked.

Duration is an actual failure time limit. Victory and failure conditions raise
candidate flags. A public timer callback adjudicates one second after the first
candidate; failure wins if both candidates occur within that window. The outcome is
then latched. Generated outcome triggers show messages and scoring; `endOnOutcome`
optionally ends the mission after 15 seconds. This arbitration is tested under mocked
Lua in opposite trigger orders, not inside DCS.

`dcs_campaign_generate` requires unique names, a single first entry stage, reachable
stages, acyclic transitions and one destination per stage/outcome. It rolls back all
new stage sessions if any mission fails. Save each stage separately. The transition
manifest is for selecting the next mission; no DCS `.cmp` or automatic cross-mission
state persistence is claimed.

The engine embeds normalized specification and generation-report JSON assets.
`dcs_miz_mission_report` recomputes **current** forces/tasks/triggers/frequencies/
assets/goals/dependencies/options/validation after later edits. Embedded generation
and director reports remain snapshots, not automatically rewritten histories.

## Cinematic mission director

`dcs_miz_direct_mission` compiles a `director` specification on an existing session.
It supports briefing, departure/recovery, AWACS/JTAC cues, detection/engagement,
reinforcements, escalation, branching, victory/failure and ending phases.

Channels assign a speaker, callsign, frequency and dialogue style. Events declare:

- An actual condition list, a preceding event, an explicit mission time, or a
  supported world event for a named unit (takeoff/land/shot/hit/kill/dead/ejection).
- Optional event-relative delay; it starts when the preceding trigger fires,
  **not** when its audio finishes. Absolute timings are explicitly `atSeconds`.
- Text or a dialogue template, audience, subtitle duration, delivery/recording notes,
  optional audio key/transmitter zone, effects and recording shot suggestion.

Dependencies are checked for cycles/missing ids. Each event gets a non-colliding
user flag and a compiled once trigger. Public world-event handlers raise signal
flags; they filter the named initiator unit. Event callbacks are guarded with pcall.
Activation effects require existing late-activated groups. Branches use dependencies
and actual flag/zone/life/death conditions. F10 check-in can use the existing radio-menu
flag actions. A detection phase driven by a zone is a zone cue, not radar detection.
JTAC dialogue does not configure a real FAC, laser designation or authenticated JTAC
procedure by itself.

All built-in NATO/Russian-style templates are labelled **fictional cinematic dialogue**.
They are not training material or authenticated radio procedures. A supplied procedure
citation is recorded as user-sourced and unverified, never automatically promoted to
an authenticated procedure.

Without an audio key, audio/radio delivery becomes subtitles plus an explicit
recording placeholder; no sound/transmission action is emitted. With an existing
WAV/OGG key, the action is configured but decoding/playback remains unverified.
Frequency radio audio is not coalition-isolated; the subtitle audience is separate.
No paid TTS, fabricated voice file or automatic playable-audio claim is used.

Reports include speaker/trigger/timing/delivery radio scripts, event dependency
timelines, flag-based shot cues and suggested 30-second highlight candidates.
These are production plans, not camera control, captured footage or rendered videos.

## Reproducible verification

```bash
npm run check
npm run build
npm test
npm run verify:design -- <new-output-directory>
# Optional stock Lua 5.1 mocked-runtime checks:
LUA51=/path/to/lua5.1 npm run verify:design -- <another-new-directory>
```

The proof command generates a .miz, reopens it, checks deterministic mission data
and writes `mission-design-verification.json`. With LUA51, it also executes generated
triggers/goals/director scripts against mocked APIs: takeoff filtering, dependent
delays, success/failure arbitration in both trigger orders, scoring and counter
rearming. A test counter is added after generation solely for this runtime harness;
the embedded scenario report remains the original generation snapshot.

See [PHASE_4_6_VERIFICATION.md](PHASE_4_6_VERIFICATION.md) for observed results and
DCS acceptance still needed. No new DCS predicate has been guessed, and no new
capability is claimed as Mission Editor opened, DCS flown, or live verified.
