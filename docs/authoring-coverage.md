# Aircraft, recovery, historical and logistics coverage

## Carrier planning

- dcs_carrier_compatibility: exact aircraft/ship type IDs, documented pairing or unknown. Sources: ED [Hornet](https://www.digitalcombatsimulator.com/en/products/planes/hornet/), [Supercarrier guide](https://www.digitalcombatsimulator.com/upload/iblock/e1b/430ooc582lpb0npynbsewan6omd5ohvs/DCS_Supercarrier_Operations_Guide_EN.pdf) and [Harrier](https://www.digitalcombatsimulator.com/en/shop/modules/av8bna/).
- dcs_miz_add_carrier_recovery: sessionId, group, ship (unit name), optional allowUnknown. Adds Land/Landing with linkUnit/helipadId exactly as installed me_route.lua lines 525–527 writes it. Rejects non-aircraft, enemy ships, malformed IDs/positions and existing landing points before mutation. Earlier route and tasks survive.
- Unlisted ships, mods and helicopters remain unknown. allowUnknown is an explicit request to author an unverified pairing. Nominal pydcs parking counts are informational: they are not exact mixed-airframe deck capacity or occupied-slot geometry.
- Native DCS controls approach and moving-deck resolution. No arrestment, taxi clearance, wind envelope or successful recovery is inferred from serialization.

## Aircraft and dates

dcs_aircraft_coverage combines pydcs fuel maxima, dimensions, tasks, compatible pylon CLSIDs, radios, installed named loadouts and sourced date records. Missing data remains unknown; a payload file does not establish performance or task support.

dcs_service_date_check takes type, year and optional country. dcs_miz_historical_report uses each mission unit's country and mission year. Current source records are deliberately small:

| DCS type | Country | Earliest year | Source and scope |
|---|---|---|---|
| F-16C_50 | USA | 1994 | [USAF fact sheet](https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104505/f-16-fighting-falcon/): Block 50–52 initial operating capability |
| FA-18C_hornet | USA | 1987 | [NAVAIR](https://www.navair.navy.mil/product/FA-18-D-Hornet): C/D operational September 1987, checked at year precision |
| A-10C | USA | 2007 | [USAF IOC announcement](https://www.af.mil/News/Article-Display/Article/125890/a-10-thunderbolt-ii-gets-technological-thumbs-up/): Precision Engagement A-10C, August 2007. Excludes A-10C_2; the later configuration is unknown. |

Results are before_service, not_before_service or unknown. Passing a lower bound does not establish continued service, operator history, exact DCS avionics or weapon fit. Omitted country uses the record's stated country, returned as evaluatedCountry. Other operators and types are unknown.

### Evidence audit and numeric profiles

`dcs_authoring_coverage_audit` returns a row per bundled plane/helicopter by default, or per requested `types` (including unknown/mod IDs). `known` counts evidence presence for fuel, all three dimensions, nonempty tasks, pylons, configurable radio presets, service-date records and deck-slot geometry. A service record is a country-scoped lower bound, not complete historical coverage. Deck-slot geometry currently has zero covered types; nominal ship parking counts must not substitute for it. The audit does not scan payload libraries or execute Lua.

`dcs_aircraft_coverage` accepts an optional `profile` object for source-backed numeric data absent from the catalogue:

```json
{"type":"Exact-Mod-ID","profile":{"type":"Exact-Mod-ID","source":"https://example.org/mod-manual","scope":"Exact variant and mod release","fuelMaxKg":1200,"dimensionsMetres":{"width":10.2,"length":12.1}}}
```

Use actual manual evidence in place of the illustrative URL/numbers above. The type must match exactly, values must be finite and positive, and URL/scope are required. Only missing fuel/dimension fields are filled; bundled values win and omitted fields remain null. `fieldSources` marks each numeric field as catalogue evidence, caller-supplied evidence with URL/scope, or null. A source URL is attribution, not independent verification. Profiles affect only the returned report: they are not persisted, do not register types, do not modify files, and do not change parking/fuel authoring defaults. Tasks, radios, weapon compatibility, deck geometry and historical bounds cannot be asserted through a numeric profile.

## Supplier links

dcs_miz_edit_warehouse patch.suppliers replaces the selected warehouse's supplier list. Each endpoint has kind airports/warehouses and positive id. New records use {Id,type}, from installed me_mission.lua addSupplier (lines 9908–9920 on DCS 2.9.31.29434). Existing matching records retain opaque fields. Missing endpoints, self-links, duplicates and different coalitions fail atomically. An empty array clears links.

Stock identity creation still requires a real donor wsType. This change does not invent ammunition identifiers or claim successful physical delivery from a saved supplier link.

## Template evidence

siteCategory distinguishes sam, radar, gun, searchlight, artillery, other and unknown. skynetRole is a prefix convention, not a verified compatibility assertion; non-SAM editor entries use none. geometry.kind is generic-column, editor-authored, mission-copied or imported, with individual-heading/source metadata. execution separately reports engaged, loaded or unverified and observed/unknown Skynet compatibility. historicalCompleteness stays unknown. Built-in IDs and layouts never change silently; select a me-* template explicitly for the installed editor layout.

## Reproduction

Build, run the full tests, then generate a new autonomous verification mission:

~~~text
npm run build
npm test
node scripts/verify-runtime-authoring.mjs <new-output.miz>
~~~

The generator refuses to overwrite a mission. It places a player observer, an AI Hornet with ship-linked recovery, an editor SAM and gun group, a real time-triggered destruction event and warehouse supplier links. Live evidence is recorded separately in verification.md.
