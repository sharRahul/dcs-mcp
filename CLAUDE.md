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

### Still unverified
Nothing here has been flown in DCS. That remains the one manual check.

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

`status` reports `phase` (menu/loading/loaded/running) and `missionEnv`. Commands that go
through `net.dostring_in('mission', ...)` still need a mission actually running.

Install with a copy into `Saved Games/DCS/Scripts/Hooks/`; DCS must be restarted to pick it
up. Confirm via `Saved Games/DCS/Logs/dcs.log` — look for `Loaded ...dcs-mcp-hook.lua` with
no adjacent ERROR line.
