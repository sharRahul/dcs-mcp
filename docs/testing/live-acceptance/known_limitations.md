# Pending or unsupported behavior

- No scenario is live-passed until the Windows operator runs and documents it.
- Terrain coordinates are explicit design placements, not terrain-cleared. Use live
  surface queries and inspect every vehicle, static, FARP and ship before evaluating AI.
- Aircraft/country/weapon catalogues are snapshots. Pylon checks do not prove all
  inter-station combinations, installed module versions or actual AI employment.
- Carrier deck capacity/type compatibility and moving-deck AI recovery are unverified;
  the recovery case is manually flown. No recovery waypoint is fabricated.
- JTAC FAC format is authored from pydcs; actual radio service/laser behavior is pending.
- CSAR automatic pickup, .cmp output, cross-mission persistence and full DCS predicate
  coverage remain outside implemented scope. Unsupported imported data is preserved.
- Mission Editor-generated full .miz donor testing must be performed on Windows. Tests
  in this repository include captured ME trigger oracles and synthetic imported archives,
  not a new run of every module/terrain or an assertion that all ME files are compatible.
- No recorded voices/TTS or third-party frameworks are bundled. Cinematic dialogue is
  fictional, and missing audio must remain an explicit placeholder.
- The runtime event ring retains 256 recent interesting events; a read returns at most
  200. Save log/telemetry for the whole sortie and use sequence cursors to detect gaps.
- Empty finite warehouses do not establish positive-stock quantities. Use a native
  donor for wsType-bearing aircraft/weapons, and document manual modifications.
- Stock Lua/mock API checks are not DCS behavior verification. Optional actual DCS Lua
  and ME fixup checks remain separate. Existing DCS-dependent skips are not suppressed.
- The bridge stays localhost-only; raw execution remains doubly gated and unnecessary
  for acceptance. Do not de-sanitize DCS or expose the TCP listener to a network.
