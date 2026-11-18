# Aircraft runtime and airfield contents implementation plan

Goal: implement the six approved aircraft inspection/control features and correct
the missing airfield scenery in the Iron Veil mission.

Architecture: structured MCP schemas call bounded mission-environment hook commands.
The single-file hook embeds a mission-local aircraft module so manual hook installs
remain supported. Actor contact data stays separate from observer world snapshots.
No new dependencies or raw Lua input. Existing unrelated local work is preserved.

- [x] Detection/history: test method filtering, missing information, stale contacts,
  bounded histories and mission-local reset. Implement controller queries without
  querying target position, velocity or coalition from world truth.
- [x] Options: inspect authored waypoint options separately from recorded bridge
  writes; report current engine values unavailable. Validate named option writes.
- [x] Lifecycle: validate set/push/pop/reset and temporary Orbit suspension/resumption.
  No setOnOff for aircraft, no arbitrary task/script input, no invented queue getter.
- [x] Support monitoring: explicit registration, bounded event evidence, group status,
  station/recovery geometry, flags and unknown service availability.
- [x] Transport: separate pickup/drop arrival, scenario-reported loading, observed
  troops at destination, and recovery. Missing troops never prove loading.
- [x] Airfield: exercise populateAirfield using real parking data and mixed statics;
  update both Iron Veil builders, generate a corrected workspace mission and verify
  saved contents and parking separation. Do not change combat logic in local scripts.
- [x] Register tools, document API/source limitations, run MCP contract tests,
  TypeScript build, Lua 5.1 harness and full regression suite.

Tests: `node --test --import tsx tests/aircraft-runtime.test.ts`, executable Lua
harness under the installed DCS luae.exe, existing hook harness, `npm run check`,
`npm run build`, `npm test`. Live DCS outcomes are separate from API-double tests.

Primary references: ED detection FAQ 1268, controller FAQ 1267, DCS User Manual,
and current installed Mission Editor data where available. Queries return
controller knowledge, not a guarantee about a particular crew's perception.

Verification result: TypeScript check/build passed; full suite 306 tests,
298 passed, 8 skipped, 0 failed. The installed DCS Lua 5.1 interpreter ran the
aircraft and hook API-double harnesses. Public-schema fixture contains the eight
new tools (183 tools total). Read-only review found two monitoring defects;
both were reproduced, fixed, covered by regression cases and re-reviewed.
The corrected mission reopened with 12 flying aircraft, 33 ground vehicles and
28 statics (8 planes, 8 helicopters, 12 vehicles); mission validation had zero
errors and five existing payload/country catalogue warnings.

Updated hook installed with a timestamped backup in the DCS Saved Games profile;
restart required. Live flight behavior and scenery visibility remain unverified.
