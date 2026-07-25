# DCS-MCP — contributor guide for AI sessions

MCP server for DCS World: offline `.miz` authoring/inspection and a live-control bridge.
Driven by any MCP client (Claude, Codex, OpenCode). TypeScript, stdio transport,
`npm run build` / `npm test`.

## Layout
- `src/miz/` — `.miz` handling: `archive.ts` (safe zip read + copy-on-write pack),
  `lua.ts` (data-only Lua parser — never executes), `serializer.ts` (writes DCS Lua),
  `parser.ts` (canonical model), `authoring.ts` (mutations + trigger compiler),
  `resources.ts` (embedded files + `mapResource`), `frameworks.ts` (MIST/MOOSE/Skynet),
  `sessions.ts`, `validator.ts`.
- `src/tools/` — MCP tool registrations (`miz.ts`, `miz-authoring.ts`, `bridge.ts`).
- `src/bridge/client.ts` — TCP JSON client for the live hook.
- `scripts/Hooks/dcs-mcp-hook.lua` — live control hook. `scripts/Export.lua` — telemetry only.

## Ground rules
- Never execute mission Lua; parse it as data (`lua.ts` only evaluates literals).
- Never overwrite a source `.miz`; `saveSessionAs`/`packMiz` write a NEW file.
- Keep raw Lua doubly gated (`DCS_ALLOW_RAW_LUA=1` + `ALLOW_EXEC` in the hook).
- Every authoring change must round-trip: serialize → reparse → assert. Add a test.
- Be honest about what needs DCS/Mission-Editor verification; don't claim unverified behavior.

---

## Triggers: compiled runtime `trig` (DONE)

`addTrigger()` in `src/miz/authoring.ts` writes BOTH forms DCS uses:
- `mission.trigrules` — the Mission Editor's structured form.
- `mission.trig.{conditions,actions,func,funcStartup,flag}` — the compiled Lua the
  simulation runs. Triggers therefore fire when a generated `.miz` is flown directly.

`compileTrig(mission)` compiles every trigrule it understands and **leaves the compiled
entries of anything it does not understand exactly as they were** — never regenerate a
working trigger from a guess. It reports `{ compiled, skipped }` by index.

### Wiring, per trigger type (captured from ME-saved missions)
| type | `trigrules.predicate` | wiring | action suffix |
|---|---|---|---|
| `once` | `triggerOnce` | `func[i]` | `; mission.trig.func[i]=nil;` (self-disarm) |
| `continuous` | `triggerContinious` | `func[i]` | none |
| `change` | `triggerFront` | `func[i]`, latched via `trig.flag[i]` | none |
| `start` | `triggerStart` | `funcStartup[i]` | none |

`conditions[i]` is `return(<a> and <b> )` — note the single space before `)` — or
`return(true)` when there are no conditions. `actions[i]` joins calls with `;` and no
space. `trig.flag[i] = true` for every compiled index.

### Ground truth, not guesswork
Predicate signatures are DCS-internal and version-sensitive, so they are **captured, never
invented**. `tests/fixtures/trig-oracle.json` pairs each `trigrules` spec with the exact
Lua the Mission Editor compiled for it (29 predicates, 19 whole triggers covering all four
types). Regenerate it after a DCS version bump:

```
npx tsx tests/build-trig-oracle.ts "<Saved Games/DCS/Missions>" tests/fixtures/trig-oracle.json
```

**Adding a predicate:** add it to the oracle's supported set, regenerate, confirm a record
appears, then write the builder in `conditionRule`/`actionRule` and the compiler in
`CONDITION_COMPILERS`/`ACTION_COMPILERS`. If no oracle record exists, do not add it.
`c_unit_alive` is deliberately absent for exactly this reason.

### Conventions the file format requires
- Triggers reference groups/units/zones by **numeric id**, never by name. The tool API
  takes names and resolves them; an unknown name throws instead of producing a dead trigger.
- `addTriggerZone` assigns a `zoneId` (see `maxZoneId`).
- Message text goes in `l10n/DEFAULT/dictionary` as `DictKey_ActionText_<n>`, where `n`
  comes from `mission.maxDictId` — one counter shared by every DictKey prefix.
- `a_end_mission` takes a `coalition.side.*` enum name, not `"blue"`.

### Tests
- `tests/trig.test.ts` — oracle match (byte-for-byte), `return(true)`, skip-preservation,
  idempotent recompile, type-change rewiring, emitted Lua parses.
- `tests/trig-runtime.test.ts` — loads an authored mission's triggers under DCS's own Lua
  (`luae.exe`) with mocked predicates and asserts real firing behaviour. Skipped unless
  `DCS_LUA` points at `<DCS>/bin-mt/luae.exe`.

### Verified in DCS (2026-07-25, Persian Gulf, DCS multithreaded)
An authored mission was loaded through the bridge and run. Confirmed live:
`triggerStart` and `triggerOnce` triggers fired at the right model times (`T3` at t=0,
`T2` at t=15) and their actions ran; the single `Load Scripts` start trigger loaded MIST,
MOOSE and Skynet in order and all three initialised; all 18 authored ground units reported
`LAND` from `land.getSurfaceType`.

Still unverified: the condition-driven triggers (`group_dead`, `unit_in_zone`,
`part_of_coalition_in_zone`, the radio-menu handler) and `end_mission` need a full sortie
that actually destroys the objectives.

---

## Resources, scripts and frameworks

`src/miz/resources.ts` embeds files under `l10n/DEFAULT/` and registers them in
`l10n/DEFAULT/mapResource` (`["ResKey_Action_N"] = "file.lua"`). Triggers reach them via
`getValueResourceByKey`. Resource keys come off the SAME `mission.maxDictId` counter as
dictionary keys — verified: a real mission carries `DictKey_ActionText_14` and
`ResKey_Action_15` side by side.

`MissionSession` carries `dictionary`, `mapResource` and `files` (a `Map<name, Buffer>`);
`saveSessionAs` writes all three. `packMiz` takes `string | Buffer` so binary resources
(`.ogg`, images) round-trip byte for byte.

### Framework load order is the whole problem
DCS walks `trig.funcStartup` with `pairs`, so SEPARATE start triggers have no defined
order, and Skynet dies if MIST is not loaded yet. Everything therefore goes into ONE
`triggerStart` commented `Load Scripts`, whose actions compile into a single ordered Lua
chunk. This matches the ME-saved Skynet/MOOSE demo missions under
`Saved Games/DCS/Missions/LUA Scripts` — check those first if the format ever seems off.

Auto-discovery must stay narrow: a loose `mist[_-].*\.lua` pattern matches MIST's own
`mist_DBs_*.lua` sample dumps and silently embeds 3 KB of nothing. Patterns match the
versioned single-file build only, and `resolveFrameworkPath` refuses an auto-discovered
file below `MIN_PLAUSIBLE_BYTES` (an explicit path is never second-guessed).

### Skynet returns proxy tables — iterate them with `ipairs`, never `pairs`

`SkynetIADS:getSAMSites()` and `getEarlyWarningRadars()` return a
`SkynetIADSTableDelegator`: a proxy that forwards method calls to its elements and carries
its own `__index` field. `pairs` therefore yields **one extra, non-site value**. Observed
in a running mission: 4 SAM sites and 3 EW radars reported for a mission containing 3 and
2, and the IADS sampler dying every 30 s with

```
attempt to call method 'isDestroyed' (a nil value)
```

`ipairs` and `#` walk the array part only and see exactly the real elements. This applies
anywhere Skynet hands back a collection — telemetry, setup scripts, and inline
`do_script` trigger actions alike.

### Trigger surface
Conditions and actions are listed in `authoring.ts`. Note two traps, both ground-truth:
- `c_start_wait_for_user` is named like a condition but DCS stores it in a trigrule's
  `actions` array. The oracle records a `role` per predicate for this reason — never infer
  it from the `c_`/`a_` prefix.
- `a_out_text_delay_g` (per-group message) takes 4 args with NO `start_delay`, unlike every
  other text action. `a_radio_transmission` stores MHz in the rule and emits Hz.

## Unit geometry

**Headings are RADIANS in the file, degrees in the API.** Verified across 17,367 real unit
headings: 99.6% fall in [0, 2pi). `headingRadians()` converts on the way out. Writing
degrees through is not a rounding error — 90 becomes 90 radians, i.e. roughly 117 degrees.

**Unit layout must be derived from the heading.** Units trail the lead along the heading
(`buildUnits`), spacing per category in `FORMATION_SPACING` (vehicles 20 m, matching the
editor's own convoys). The old fixed `x + 30, y + 30` offset strung every group out to the
north-east regardless of facing, which reads in the editor as a group sitting at 45 degrees
to its own direction of travel. If you see `56.57` in a spacing analysis, that is `40 * sqrt(2)`
— the fingerprint of exactly this bug.

Note DCS map axes: `x` is NORTH, `y` is EAST, so a heading's forward vector is
`(cos h, sin h)`. Also: if a group has 2+ route points the editor overwrites each unit's
heading from `atan2(p2 - p1)`, so an authored heading only sticks on a single-point group.

**A SAM site is not N copies of one vehicle.** `addGroundGroup` takes an optional
`composition: [{ type, count }]` that puts mixed unit types in ONE group, laid out in
order along the heading (`spacingMetres` overrides the per-category default). Skynet finds
a site by group name and then looks *inside* it for a search/track radar and launchers — a
group of launchers alone registers with the IADS and never fires. Compositions are copied
from ME-saved missions, not invented; `demo-missions/skynet-test-persian-gulf.miz` has a
working one for every common site type.

## Terrain: never trust a coordinate you did not check

`dcs_check_terrain` (hook `land`) batches `land.getSurfaceType` in the mission environment
and is the only authoritative land/water answer. A ground group on water does NOT error at
load — the vehicles sit inert, which reads as broken AI, not as a bad placement. It needs a
mission running. Two ways to get a trustworthy coordinate:
- lift it from an ME-saved mission (the editor put a vehicle there, so it is land), or
- spawn something on the map and query it.
Do both when it matters: `scripts/dcs-mcp-telemetry.lua` re-checks every ground unit five
seconds into the mission and logs `TERRAIN_WATER` as an ERROR for any that are wet.

## Getting from a built .miz to a running mission

`dcs_load_mission` (hook `loadmission`) calls `net.load_mission`, which **swaps the mission
on an already-running session** — it is the server mission-rotation call (DCS's own
`common.lua` gates it behind `DCS.isServer()`). It does NOT start a mission from a cold
menu: verified on this install (DCS multithreaded), from a cold menu `net.load_mission`
returns nil and does nothing — no `onMissionLoadBegin`, no load — from BOTH the GUI render
tick and an `onSimulationFrame` tick (`onSimulationFrame` does fire at this install's menu,
so `simTicking` is true there; it still no-ops). There is no menu→mission API a Lua hook
can drive; a true cold start would need `net.start_server(settings)`, which hosts an MP
server and changes single-player semantics, so it is deliberately not used.

The hook therefore **refuses `loadmission` unless `phase == "running"`**, with a clear "no
mission is running" error, instead of reporting a phantom success. To go from a built `.miz`
to flying: start any mission once (fly it), then `dcs_load_mission` swaps in the authored
one. `net.load_mission` only takes effect on the simulation thread, so `loadmission` is held
for an `onSimulationFrame` tick like the mission-env commands (`needsSimThread`).

Loading is **asynchronous**: it returns before the mission is up, and a mission that fails
to open reports it in dcs.log and nowhere else. Poll `dcs_bridge_status` for
`phase: running -> loading -> running`, then read the log.

## Live telemetry

`scripts/dcs-mcp-telemetry.lua` runs in the mission environment (load it last, after the
frameworks) and writes `[DCSMCP] <KIND> key=value ...` lines to dcs.log: framework presence,
the terrain audit, world events, player state, per-site IADS status, and `DCSMCP.trig(name)`
for triggers to call from a `do_script` action. That last one matters — a trigger that never
fired and a trigger that fired into a broken action are otherwise indistinguishable.

The log is the transport on purpose: it is the one channel that still works while the
mission is loading and after a script has blown up. `scripts/monitor-flight.mjs` tails it
incrementally alongside a bridge poll and maintains a small `digest.json`.

`scripts/build-e2e-mission.mjs` builds a full Persian Gulf test mission through these APIs;
`scripts/verify-mission.mjs` runs the offline acceptance checks (validator, ED's own
`fixUnitsPos`, compiled-trigger syntax, unit geometry) against any `.miz`.

## Two invariants the Mission Editor enforces

**Every group needs `route.points[1]`.** `me_mission.lua:fixUnitsPos` indexes it
unconditionally for any group that has a `route`, so an empty `points` table makes the
editor fail to open the WHOLE mission with `attempt to index field '?' (a nil value)` —
and nothing points at the group responsible. No ME-saved mission has an empty route.
`initialRoute()` seeds one at the spawn position; `validator.ts` reports
`GROUP_NO_ROUTE_POINTS` as an ERROR; `tests/fixtures/me-open.lua` runs ED's own
`fixUnitsPos` under `luae.exe` so this fails in tests, not in the GUI.

**Check the log after generating a mission.** `dcs_status` / `dcs_get_log_errors`
(`src/dcs/log.ts`) read `Saved Games/DCS/Logs/dcs.log`, which is the only error channel
that works when no mission is running — and the only place an ME load failure is reported.
The route bug above was found this way and nowhere else.

## The live hook
`scripts/Hooks/dcs-mcp-hook.lua` runs in DCS's GUI environment, which is **Lua 5.1**:
`load(string)` is invalid there (`loadstring` is the 5.1 API), and DCS reports the failure
as a single dcs.log line while the bridge silently never listens. Parsing the hook is not
enough to catch that class of bug — `tests/hook.test.ts` LOADS it under `luae.exe` with the
DCS globals stubbed and drives its callbacks. Keep that test passing.

The hook opens its socket when it LOADS, and services requests from two tick sources:
`onSimulationFrame` (mission only) and `Gui.AddUpdateCallback` (the GUI updater
UserHooks.lua drives the menus with — confirmed present in the hook environment on this
install). So the bridge answers in the menu and the Mission Editor. The GUI updater is not
a documented hook API: keep it defensive — registered only if present, pcall'd, and
dropped after repeated failures rather than risking the user's UI.

### `net.dostring_in('mission', ...)` only works on the simulation thread

**Verified on this install, DCS multithreaded.** Called from the GUI updater it does not
reach the mission scripting state — and it does not fail loudly. The snippet runs somewhere
that has no `coalition`, `timer`, `land` or `coord`, so with a mission demonstrably running
every mission-env command came back:

```
attempt to index global 'coalition' (a nil value)
```

`MISSION_ENV_COMMANDS` in the hook lists the affected commands; `service(source)` holds
such a request until an `onSimulationFrame` tick dispatches it. Do not "simplify" that
away. Corroboration: DCS-gRPC never calls `net.dostring_in` at all — it enters the mission
environment through its native DLL.

A paused mission produces no frames, so a held request is answered with that reason after
`SIM_STALL_S` rather than left to time out.

`status` reports `phase` (menu/loading/loaded/running), `simTicking` and `missionEnv`.
**`missionEnv` is derived from simulation frames, never from a dostring probe** — the old
`net.dostring_in("mission", "return 'ok'")` probe returned `"ok"` from the wrong state and
reported a reachable environment for commands that then failed on a nil global.

`tests/fixtures/hook-load.lua` drives both tick sources under `luae.exe` and asserts
`GUI_HELD` / `SIM_ANSWERED` / `GUI_PING_ANSWERED`, so the routing is a tested invariant.

Install with a copy into `Saved Games/DCS/Scripts/Hooks/`; DCS must be restarted to pick it
up. Confirm via `Saved Games/DCS/Logs/dcs.log` — look for `Loaded ...dcs-mcp-hook.lua` with
no adjacent ERROR line.
