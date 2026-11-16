# DCS-MCP verification record

Baseline: `main` at `796860b`, package/server version 0.2.0. The initial checkout
already contained package-lock.json changes; this work does not replace them.
The implementation is an uncommitted working-tree change, not a release or deployed server.

## Baseline

On Linux, Node 24.22.2 / npm 11.19.1:

```text
npm run build && npm test
131 tests: 126 passed, 0 failed, 5 skipped
```

The five skips require DCS's Lua interpreter or Mission Editor installation.
The baseline Windows workflow targets Node 18, 20 and 22. No lint script existed;
strict TypeScript compilation was the static check.

## Reproduce the current checks

```bash
npm ci
npm run check
npm run build
npm test
npm pack --dry-run
npm run verify:capabilities -- <new-output-directory>
```

`check` runs strict TypeScript without emitting files. The existing build/test
contracts remain available. `verify:capabilities` writes `capability-proof.miz`
and `verification.json`, asserts validation/save/reopen and selected authored
fields, and independently checks an analytical ridge grid. Its terrain is clearly
labelled **synthetic**, never offered as real terrain at the mission's coordinates.
It refuses to overwrite an existing .miz. ZIP timestamps may change archive hashes
between otherwise equivalent runs.

The Windows workflow now includes typecheck, build, tests, packaging and a Node 22
offline acceptance artifact uploaded as `offline-capability-proof`. The edited
workflow has not been run on a Windows runner during this session.

The same Node versions can be checked locally without changing the project dependencies:

```bash
npx --yes --package=node@18 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
npx --yes --package=node@20 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
npx --yes --package=node@22 -c 'node --version && node node_modules/typescript/bin/tsc --noEmit && node scripts/run-tests.mjs'
```

## Test coverage added

- `tests/flight.test.ts`: all 13 roles serialize/reparse; targets and radio/TACAN
  task fields; atomic invalid combinations; per-unit settings; fuel/pylon limits;
  parking fit/duplicates; shared FARP capacity; raw reference checks and opaque
  EPLRS/unknown-task preservation.
- `tests/terrain.test.ts`: independent analytical planes, bilinear interpolation,
  no-data/coverage handling, ridge masking, observer height, Earth curvature,
  range limits, inner viewshed cells, route water/grade checks, sample budgets,
  and mock TCP bridge batching/theatre checks. No real terrain is used.
- `tests/operations.test.ts`: rotated ground layouts, patrol loop, defensive
  stationarity, all existing SAM compositions, F10 preservation, surface tasking,
  dangling waypoint validation, ordered IADS setup and Lua 5.1 syntax.
- `tests/logistics.test.ts`: exact untouched-member bytes, edited stock wsType
  preservation, opaque data, malformed edits rejected atomically, supplier
  restrictions, defaults, save/reopen and snapshot restoration.
- `tests/advanced-server.test.ts`: real stdio MCP client discovery, role flight,
  advanced task, airfield landing, rejected payload, terrain placement/rejection
  of every footprint, warehouse edits, validation, save and reopen.

Existing bridge timeout/security, archive safety, trigger oracle, editing,
projection, inventory and log tests remain in the full suite.

## Stock Lua 5.1 integration check

Build first and point `LUA51` at a stock Lua 5.1 interpreter:

```bash
LUA51=/path/to/lua5.1 npm run verify:lua51
```

For this session, stock Lua 5.1.5 was built in /tmp from the official source archive
at https://www.lua.org/ftp/lua-5.1.5.tar.gz using its `src` generic make target.
This is separate from `DCS_LUA` and does not turn the existing DCS-dependent skips
into passes. No runtime dependency was added to the repository.

The harness runs generated IADS setup and the trusted telemetry script against
mock DCS/Skynet globals. It checks configured parameters, activation, proxy-array
iteration, registry sampling and deduplication with a legacy alias. Output:

```text
LUA51_ADVANCED_OK mocked setup, proxy iteration, telemetry, and deduplication; NOT DCS verified
```

This proves stock Lua 5.1 execution under mocks, not actual framework initialization,
sensor modeling, DCS API compatibility, Mission Editor loading or flight behavior.
The harness never executes Lua extracted from an untrusted mission.

## Reference data reproducibility

The additional pylon/ship facts were generated from `pydcs==1.0.0` (LGPL-3.0-or-later),
read as AST literals without importing or executing the package. Source-file SHA-256
values are embedded in `data/authoring.json`.

```text
pydcs-1.0.0-py3-none-any.whl SHA-256:
584570bf42bbfabbb1257bc737eb232d21aa7814cba7dfe0ba653a36aa993dd5

data/authoring.json SHA-256:
f661e999a52e015bb74627a56adfd04b4650dbbefdb20fb3888ad34873e3ea4b
```

```bash
python3 -m pip download --no-deps pydcs==1.0.0 -d <reference-directory>
# Extract the wheel there with Python's zipfile, without importing pydcs.
python3 -I scripts/gen-authoring-data.py <reference-directory> <regenerated.json>
```

Regenerating during this session produced a byte-identical file. Catalogue data
is snapshot evidence, not evidence of the DCS version installed on another machine.

## DCS acceptance still required

No new feature has been opened in the Mission Editor or tested inside DCS World.
Prior sortie observations in CLAUDE.md retain their original scope and date.

With a Windows DCS installation, a human acceptance run should:

1. Run existing DCS_LUA checks with the real interpreter/install; open the generated
   proof mission and inspect validation/log errors.
2. Spawn hot/cold/runway/carrier/FARP flights; inspect requested parking, radio,
   callsign, livery, per-unit skills, formation, payload and landing waypoints.
3. Fly AI CAP/SEAD/CAS/escort/intercept tasks and AWACS/tanker stations, verify
   duration, frequency and TACAN; check that unknown combinations remain reported.
4. Use real frameworks with the IADS configurator. Confirm load order, actual site
   counts, go-live/HARM behavior and periodic registry telemetry. Exercise the
   catalogue SAM batteries before promoting any provenance.
5. Check live terrain coordinates/heights against the loaded theatre, multiple
   ridge/LOS cases and every placed unit. Confirm the F10 circles load correctly.
6. Exercise convoy/patrol/assault, Combined Arms control and naval surface tasks.
   Verify carrier operations separately; moving-deck recovery is still unsupported.
7. Test finite stock depletion, fuel, resupply and edited warehouse restrictions in
   DCS, including existing ship/FARP inventories and a second save/reopen.

Real elevation datasets, historical dates, radio bands, livery/callsign databases,
carrier compatibility/recovery evidence and new stock metadata are still absent.
See AUTHORING.md for the precise supported/unsupported boundary.

## Final observed results

| Check | Environment | Result |
|---|---|---|
| Strict typecheck, build and full suite | Linux, Node 24.22.2 / npm 11.19.1 | PASS; 177 tests, 172 passed, 5 skipped, 0 failed |
| Strict typecheck and full suite | Linux, Node 18.20.8 | PASS; 172 passed, 5 skipped |
| Strict typecheck and full suite | Linux, Node 20.20.2 | PASS; 172 passed, 5 skipped |
| Strict typecheck and full suite | Linux, Node 22.23.5 | PASS; 172 passed, 5 skipped |
| Generated setup and telemetry runtime | Stock Lua 5.1.5, mocked APIs | PASS; not DCS verification |
| Offline acceptance mission + JSON report | Compiled dist modules | PASS; validation and save/reopen assertions |
| Data regeneration | Pinned pydcs 1.0.0 | Byte-identical authoring.json |
| Package dry run | npm | PASS; 206 files, including generated data/new tools/runtime harness |

Machine-readable evidence:
[checks.json](evidence/checks.json) records commands, results and source hashes;
[offline-acceptance.json](evidence/offline-acceptance.json) records the actual proof
mission digest and analytical terrain assertions. The local generated mission is
`/tmp/dcs-capability-final/capability-proof.miz`, SHA-256
`25195d9bae0ddfdba2f0c715ca99e250758623819719ea39414c19f91a8073fa`.
Regenerate into a new directory using the command above. None of this upgrades
DCS runtime verification or any existing SAM template's provenance.

## Later mission-design verification

Phases 4–6 add mission configuration/assets/drawings, structured scenarios and a
cinematic director. Their newer results and proof artifacts are recorded separately
in [PHASE_4_6_VERIFICATION.md](PHASE_4_6_VERIFICATION.md). The earlier results above
remain the historical record for the preceding capability additions.
