# DCS-MCP verification

Single verification record. Historical results retain their original scope; current live DCS acceptance remains pending.

## Mission design verification


This record covers DCS-MCP's Phase 4–6 working-tree additions. Package version
remains 0.2.0; nothing was published or deployed. Existing work, including the
pre-existing package-lock.json and .gitignore edits, was retained.

### Baseline and final local checks

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

### Reproduce

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

### Artifacts and packaging

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

### Remaining acceptance and explicit limits

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

### Node compatibility matrix

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

## Bridge, security, Zod 4 and live acceptance — 2026-11-16

The baseline for this continuation was v0.2.0 at `796860b`; prior authoring work
was committed as `0ac9c15`. Baseline: npm ci/build/test passed, 206 tests,
201 passed and five DCS-interpreter tests skipped because DCS is not installed.
Open GitHub issues were queried: none were open at assessment time.

This is the single Markdown verification record. Historical records were merged
here; `docs/evidence/` is ignored and is not used as verification evidence.
All documentation filenames are lowercase. Native capability assessment is in
[capability_gap_analysis.md](capability_gap_analysis.md).

### Implemented and tested scope

- `src/security/files.ts`: same-directory temporary file, fsync, atomic publication,
  exclusive non-overwrite saves, source inode/alias protection and temporary cleanup.
- `src/security/archive-policy.ts`: declared expansion limits, duplicate/case and
  separator aliases, Windows reserved paths, ADS/control characters, suspicious
  zero-size compressed entries and invalid size metadata. The patched ZIP library
  supplies decompression safeguards; existing resources/unknown fields remain preserved.
- `src/security/transport.ts`, input-budget.ts: SDK framing at 64 MiB, collection,
  node-count and depth budgets before tool schema validation. No network listener.
- `src/bridge/client.ts`: bounded requests/responses, incremental UTF-8 decoding,
  strict envelopes, deadlines and structured BridgeError codes. The hook bounds
  pending connections, handles partial sends and reports asynchronous load errors.
- Hook `runtime` and `dcs_runtime_inspect`: read-only named groups and unit state,
  user flags/objectives, acceptance identity and event cursor/ring metadata.
  Event collection is explicitly unavailable without mission telemetry.
- `src/acceptance/`: ten missions, safe archive/geometry/trigger/Lua checks,
  detailed per-scenario manifest and operator kit; bounded, read-only source
  evidence collection into a fresh folder, SHA-256 hashes and run/outcome correlation.
  Collection never interprets screenshots or automatically proves aircraft AI.
- MCP tools: `dcs_acceptance_check`, `dcs_acceptance_generate`, `dcs_acceptance_job`,
  `dcs_acceptance_collect`, `dcs_runtime_inspect`, `dcs_tool_catalogue`.
  Generation exposes progress and permits one concurrent job, retaining twenty
  process-local jobs; job status is lost on server restart, files remain.

Tests include all ten generated missions, overwrite failure, corrupt archives,
input budgets, malformed bridge envelopes, split UTF-8, racing writers/source
aliases, synthetic evidence collection, traversal rejection, identity mismatch,
error detection and public SDK discovery. Synthetic attestation fixtures do not
constitute a DCS live result.

### Dependency and public schema review

User approved migration to Zod 4 and raising the runtime minimum to Node 20.
Dependencies: Zod 4.6.7, MCP SDK 1.32.2, adm-zip 0.6.1, patched transitive packages.
Node 18 support is removed because the patched SDK HTTP adapter requires Node 20.
The server still uses stdio; it does not expose HTTP endpoints. Windows CI now
covers Node 20/22/24, with the ten-mission acceptance kit generated on Node 22.
There is no Linux CI job. Stock Lua results below are local offline checks only.

Reviewed all 98 pre-migration tool input schemas against SDK tools/list after
migration. Names and fields are retained. Sixty were structurally equal ignoring
object-key order; 38 had representation differences. After expanding refs,
normalizing mutually exclusive discriminated unions, scalar union representations
and safe-integer bounds, 93 were equivalent. The remaining five were reviewed:

- `dcs_convert_coords`: SDK/Zod 3 had advertised an empty object for the refined
  schema; Zod 4 correctly exposes direction, coordinates, altitude and bridge
  settings. Existing runtime requirements remain; discovery is corrected.
- `dcs_miz_direct_mission`, `dcs_scenario_validate`, `dcs_scenario_generate`,
  `dcs_campaign_generate`: optional director audience and asset side now advertise
  the existing blue defaults. Their authoring behavior already defaults to blue.
- Zod 4 `.int()` rejects unsafe integers. Error wording/issue structures may change;
  clients should use the error status and actionable message rather than parsing
  Zod-specific error prose. No implicit arbitrary Lua fallback was added.

The final 102 input/output schemas are locked by SHA-256 regression fixtures in
`tests/fixtures/mcp-schema-sha256.json`, exercised through a real stdio SDK client.

### Reproduction and live status

```bash
npm ci
npm run build
npm test
npx tsc --noEmit
npm run check
npm audit
npm pack --dry-run
npm run verify:capabilities -- /tmp/dcs-capability-proof-new
LUA51=/path/to/lua5.1 npm run verify:lua51
LUA51=/path/to/lua5.1 npm run verify:design -- /tmp/dcs-design-proof-new
/path/to/lua5.1 tests/fixtures/hook-load.lua scripts/Hooks/dcs-mcp-hook.lua
/path/to/lua5.1 tests/fixtures/hook-runtime.lua scripts/Hooks/dcs-mcp-hook.lua
npm run acceptance:generate -- /tmp/dcs-live-kit-new
LUA51=/path/to/lua5.1 npm run acceptance:lua51 -- /tmp/dcs-live-kit-new
```

Lua compilation reparses the .miz into data-only tables and serializes trusted data
into a temporary file. It never executes package-supplied raw Lua. Stock Lua checks
execute vetted hook/setup code with mocks and compile generated trigger functions;
they do not prove DCS AI, terrain, sensor, weapon, JTAC or carrier behavior.

All ten generated scenarios are **LIVE PENDING**. Exact Windows setup, Mission
Editor/flight steps, measurable results and evidence checklist are in
[testing/live-acceptance/readme.md](testing/live-acceptance/readme.md).
Each scenario manifest includes units/positions, tasks, triggers, frequencies,
radio placeholders, objectives, special procedures, limitations and eight checks.
Separate failure/branch sorties need separate collected reports.

Remaining environment-dependent work: execute the live matrix; provide an existing
Mission Editor donor archive and verify native save/reopen preservation; supply
native positive warehouse inventories before positive stock exhaustion tests;
verify actual JTAC designation, carrier launch/arrested recovery and terrain-aware
routes. Case 09 positive-stock criteria stay blocked without a donor. Carrier
recovery is manual and requires visual evidence; a generic LAND event is insufficient.
No native .cmp campaign, complete ME trigger catalogue, authoritative offline radar
model, historical equipment database or automated CSAR pickup is claimed.

### Final local results

Linux, Node v24.22.2, stock Lua 5.1.5:

| Command | Result |
|---|---|
| npm ci | Passed; clean lockfile install |
| npm run build | Passed |
| npm test | 213 tests: 208 passed, 0 failed, 5 existing DCS-interpreter skips |
| npx tsc --noEmit; npm run check | Both passed |
| npm audit | Zero vulnerabilities (patched @hono/node-server 2.1.8) |
| npm pack --dry-run | Passed; operator documents included; no package published |
| npm run verify:capabilities | Passed; offline-only proof archive reparsed |
| LUA51=... npm run verify:lua51 | LUA51_ADVANCED_OK with mocks |
| LUA51=... npm run verify:design | Success/failure, forward/reverse mocked runtime cases passed |
| Lua 5.1 hook-load and hook-runtime harnesses | Passed; no DCS APIs executed |
| npm run acceptance:generate | Ten archives passed offline structural checks; all live pending |
| LUA51=... npm run acceptance:lua51 | Ten generated missions compiled; no DCS APIs executed |
| git diff --check; lowercase docs filename check | Passed |

The older e2e mission builder requires locally installed third-party framework
resources; its actual live/framework exercise remains an operator task. Interactive
log monitoring and hook installation are not run against a nonexistent DCS profile.
Hook installation, archive resources and framework failures have automated tests.

Continuation targets: `src/miz/flight.ts` and `src/acceptance/cases.ts` for any
carrier/flight task corrections supported by live results; `src/miz/logistics.ts`
for donor-backed inventory refinements; `src/terrain/` for sourced terrain coverage;
`src/miz/trigger-schema.ts` and authoring compiler for additional oracle-backed
predicates. Add a genuine ME donor fixture to `tests/fixtures/` only when supplied
with redistribution permission. Record live evidence using the generated kit and
update this document with observed results, never presumed behavior.

GitHub CI completed successfully for implementation commit `fab09f4`; see the completed run below.


### CI correction and Windows-only workflow

The first PR workflow run [43868581786](https://github.com/sharRahul/dcs-mcp/actions/runs/43868581786)
failed the new schema-hash test because diagnostic log-path help text embedded the
host home directory. The description now names the resolution rule without a
machine-specific path. Reviewed schema hashes were updated for that description;
the full schema assertion remains enabled. Runtime log-path resolution is unchanged.

At the user's request CI runs only on Windows. The Linux stock-Lua job was removed;
Node 22 on Windows generates and uploads the complete offline-checked acceptance
kit. Local stock Lua 5.1 checks are explicitly mock/format evidence. Actual DCS
execution remains the manual Windows acceptance stage.


### Completed GitHub CI

[Windows CI run 43868925800](https://github.com/sharRahul/dcs-mcp/actions/runs/43868925800)
completed **successfully** for `fab09f44bf936694c1c7f34b6f67fdea9b174b83`:
Node 20, 22 and 24 on Windows all passed. Node 22 also passed package inspection,
capability/design proof generation and ten-mission acceptance-kit generation.
The run uploaded `offline-capability-proof` and `live-acceptance-kit-offline-only`.
These are Windows offline test results; the five existing DCS-dependent tests remain
skipped and none of the ten scenarios is live-passed.

Branch: `feat/mission-acceptance-hardening`. Draft [PR #5](https://github.com/sharRahul/dcs-mcp/pull/5)
targets main; it is not merged. Commits include authoring/scenarios `0ac9c15`, patched
dependencies `4815772`, acceptance/bridge hardening `aa58f9c`, lowercase documentation
`8e6c65f`, CLI validation `185cda2`, and portable schema/Windows CI `fab09f4`.
This final documentation commit records those observed results. No npm package or
public release was published.

### Stock Lua 5.1 CI converted to Windows

At the user's direction, the stock Lua checks now have a dedicated Windows job,
`Lua 5.1 offline checks on Windows`; no Linux runner is configured. The job builds
Lua 5.1.5 with MSVC from the [official Lua source archive](https://www.lua.org/ftp/)
using the published SHA-256 `2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`.
`scripts/build-lua51.ps1` verifies the hash before extracting or compiling and
requires a fresh build directory. The MSVC setup action is pinned to a commit.

It runs advanced setup, design success/failure cases, hook loading, partial-write/
runtime protocol mocks and compilation of all ten acceptance missions. The stock
interpreter is set only as `LUA51`, never as `DCS_LUA`; DCS-specific tests remain
honestly skipped until DCS is installed. Its artifact is
`windows-lua51-offline-proof`. These Windows Lua checks still do not execute DCS.

[Completed Windows CI run 43869548671](https://github.com/sharRahul/dcs-mcp/actions/runs/43869548671)
passed all four jobs for `3b3b238be9a17efba42bbad7912137836095651e`: Node
20/22/24 and the dedicated Windows stock Lua 5.1 job. MSVC source compilation,
hook-load/runtime harnesses, advanced/design mocked runtime checks and ten-mission
Lua compilation all passed. The `windows-lua51-offline-proof` artifact is available
on that run. This supersedes the earlier Windows-only Node matrix evidence with
the completed Windows Lua conversion; live DCS acceptance remains pending.
