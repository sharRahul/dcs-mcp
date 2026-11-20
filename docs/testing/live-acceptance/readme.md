# DCS Sortie MCP live acceptance package

All scenarios start **LIVE PENDING**. Offline checks prove file structure and Lua syntax,
not aircraft AI, weapons, carrier behavior, JTAC services or logistics inside DCS.

Prerequisites: Windows DCS World, F-16C and F/A-18C modules for their player scenarios,
Caucasus terrain, Node 20+ and this repository. Stock Stennis avoids requiring a
Supercarrier-specific deck. No mods, paid TTS, MIST, MOOSE or Skynet are bundled.
Optional frameworks must be supplied explicitly and their initialization tested.

From the repository (PowerShell):

```powershell
npm ci
npm run build
npm test
npm run acceptance:generate -- .\live-acceptance-run
$env:LUA51 = 'C:\Program Files\Eagle Dynamics\DCS World\bin-mt\luae.exe'
npm run acceptance:lua51 -- .\live-acceptance-run
node dist/index.js install-hook --saved-games "$env:USERPROFILE\Saved Games\DCS"
```

Use a NEW output directory; generation refuses to overwrite an existing package.
The generated `manifest.json` is authoritative for exact units, positions, routes,
tasks, flags, radio cues, SHA-256 digests and per-scenario checks. `reports/*.json`
contains independent archive/structural/Lua/geometry/trigger checks and mission reports.
`specifications/*.json` records the normalized requests. Each mission embeds telemetry
and a unique package/scenario identity marker. Copy the generated missions to DCS's
Missions folder without changing their contents; preserve originals when resaving.

Restart DCS after hook installation. The hook binds **127.0.0.1:8899 only**. Keep
ALLOW_EXEC=false and DCS_ALLOW_RAW_LUA unset. Runtime inspection, messages and structured
spawn do not require arbitrary Lua. Do not de-sanitize MissionScripting.lua for these tests.

Read TEST_MATRIX, then execute MANUAL_TEST_PLAN in order. Evidence collection after a
sortie is read-only against DCS/logs and never starts, replaces or flies a mission:

```powershell
npm run acceptance:collect -- .\live-acceptance-run 01-f16-sead "$env:USERPROFILE\Saved Games\DCS\Logs\dcs.log" .\evidence-sead --results .\operator-results.json
```

A log from another run cannot pass: the package identity must match. Without completed
operator checks and evidence files, collection reports pending, not live-pass. See
results_template.md for the JSON shape. Store screenshots next to that results file;
use relative paths. Generated evidence is local/private; review before sharing.

A cold-menu mission start is manual: select the mission and press Fly. `dcs_load_mission`
only swaps an already running session and returns an asynchronous request, not a flight
success. Never invoke it during an unrelated flight without explicit operator intent.

While DCS is running, query `dcs_runtime_inspect` with the manifest group names and outcome flag; save the response alongside operator evidence. Log collection works after DCS closes and does not require bridge access.

CI runs stock Lua 5.1 checks on Windows in a dedicated job. To reproduce its
interpreter build, open an x64 Visual Studio developer PowerShell and run
`./scripts/verify/build-lua51.ps1 -OutputDirectory C:\temp\stock-lua51-new`.
Set `LUA51` to the printed executable path and run the compilation command above.
This builds hash-checked official stock Lua; it does not install or run DCS.
