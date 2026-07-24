# DCS-MCP — contributor guide for AI sessions

MCP server for DCS World: offline `.miz` authoring/inspection, a live-control bridge,
and a minimalist local web GUI. TypeScript, stdio transport, `npm run build` / `npm test`.

## Layout
- `src/miz/` — `.miz` handling: `archive.ts` (safe zip read + copy-on-write pack),
  `lua.ts` (data-only Lua parser — never executes), `serializer.ts` (writes DCS Lua),
  `parser.ts` (canonical model), `authoring.ts` (mutations), `sessions.ts`, `validator.ts`.
- `src/tools/` — MCP tool registrations (`miz.ts`, `miz-authoring.ts`, `bridge.ts`).
- `src/bridge/client.ts` — TCP JSON client for the live hook.
- `src/gui/` — Express server (`server.ts`) + inline page (`page.ts`).
- `scripts/Hooks/dcs-mcp-hook.lua` — live control hook. `scripts/Export.lua` — telemetry only.

## Ground rules
- Never execute mission Lua; parse it as data (`lua.ts` only evaluates literals).
- Never overwrite a source `.miz`; `saveSessionAs`/`packMiz` write a NEW file.
- Keep raw Lua doubly gated (`DCS_ALLOW_RAW_LUA=1` + `ALLOW_EXEC` in the hook).
- Every authoring change must round-trip: serialize → reparse → assert. Add a test.
- Be honest about what needs DCS/Mission-Editor verification; don't claim unverified behavior.

---

## OPEN TASK: make triggers precise (compiled runtime `trig`)

### Where it stands
`addTrigger()` in `src/miz/authoring.ts` (tool `dcs_miz_add_trigger` in
`src/tools/miz-authoring.ts`) writes ONLY the Mission Editor's structured
`mission.trigrules`. Supported today:
- Conditions: `time_after`, `flag_is_true`, `flag_equals`.
- Actions: `message`, `set_flag`, `activate_group`, `end_mission`.

DCS regenerates the runtime `mission.trig` tables only when the mission is opened and
saved in the Mission Editor. So triggers currently require an ME finalize pass and are
NOT guaranteed to fire if the `.miz` is flown directly.

### Goal
Emit the compiled `mission.trig` tables alongside `trigrules` so triggers work without an
ME round-trip, and widen the supported condition/action set — with each mapping verified
against a real DCS-saved mission, not guessed.

### Why it's not done yet
The exact runtime function names/signatures (`c_time_after`, `a_out_text_delay`,
`getValueDictByKey`, the `func`/`funcStartup` wiring, per-predicate field names) are
DCS-internal and version-sensitive. They must be captured from ground truth, not invented.

### Ground-truth method (do this first)
1. In the DCS Mission Editor, build one mission per supported condition/action combo
   (e.g. ONCE + TIME MORE → MESSAGE TO ALL; CONTINUOUS + FLAG IS TRUE → ACTIVATE GROUP).
2. Save, unzip the `.miz`, and read the `mission` entry. Record verbatim:
   - `mission.trigrules[i]` field names per predicate (`predicate`, `rules`, `actions`,
     and each param key like `seconds`, `flag`, `zone`, `text`, `value`).
   - `mission.trig.conditions[i]` — the exact Lua string, e.g. `return(c_time_after(3600) )`.
   - `mission.trig.actions[i]` — e.g. `a_out_text_delay(getValueDictByKey("DictKey_..."), 10, false)`.
   - `mission.trig.func[i]` and `funcStartup[i]` wiring, and `trig.flag[i]`.
   - How message text is stored: literal vs a `DictKey_...` reference added to
     `l10n/DEFAULT/dictionary` (mutate `session.dictionary` if the latter).
3. Put a couple of these captured `.miz` files under `tests/fixtures/` as oracles.

### Implementation plan
1. Add a `compileTrig(mission)` pass in `authoring.ts` that, from the structured
   `trigrules`, writes matching `trig.conditions` / `trig.actions` / `trig.func` /
   `trig.funcStartup` / `trig.flag`. Index alignment between `trigrules[i]` and `trig.*[i]`
   must match what the ME produces (confirm from the oracle files).
2. If message text uses dictionary refs, allocate `DictKey_...` entries in
   `session.dictionary`, bump `mission.maxDictId`, and have `saveSessionAs` write the
   dictionary entry (it already re-serializes `l10n/DEFAULT/dictionary` when present).
3. Extend conditions/actions to at least: `unit_in_zone`, `part_of_coalition_in_zone`,
   `group_dead`, `user_flag`; actions `radio_transmission`, `explode`, `smoke`,
   `group_activate`, `flag_off`. Add each only after capturing its ground truth.
4. Add reference validation in `validator.ts`: every `activate_group` names an existing
   group; every zone-based condition names an existing zone; flags are integers.
5. Tests: for each supported trigger, assert the emitted `trig.*` strings byte-match the
   oracle fixture (normalize whitespace), plus the existing round-trip assertions.

### Acceptance criteria
- Building a supported trigger and saving produces `trig.*` strings identical (modulo
  whitespace) to an ME-saved oracle for the same trigger.
- Reference validation rejects triggers pointing at missing groups/zones.
- A generated `.miz` with a trigger fires when flown directly (verify on a real DCS install;
  note this in the PR as the one manual check).
- Round-trip and reference tests pass; `npm run build` and `npm test` are green.

### Files to touch
`src/miz/authoring.ts` (compile pass + new specs), `src/tools/miz-authoring.ts` (widen
enums + descriptions), `src/miz/validator.ts` (reference checks), `src/miz/sessions.ts`
(dictionary/maxDictId handling if needed), `tests/authoring.test.ts` + `tests/fixtures/`.
