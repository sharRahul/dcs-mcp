# Mission design verification record

This record covers DCS-MCP's Phase 4–6 working-tree additions. Package version
remains 0.2.0; nothing was published or deployed. Existing work, including the
pre-existing package-lock.json and .gitignore edits, was retained.

## Baseline and final local checks

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

## Reproduce

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

## Artifacts and packaging

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

## Remaining acceptance and explicit limits

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

## Node compatibility matrix

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
