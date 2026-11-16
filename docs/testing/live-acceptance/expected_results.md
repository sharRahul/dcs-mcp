# Measurable acceptance results

Offline: ten missions, ten specifications, ten reports; every report has ok=true,
valid Lua 5.1 syntax, finite geometry and matching supported trigger compilation.
No AI-behavior or live check is marked passed. Existing output paths are refused.

Live lifecycle: menu vs running is distinguishable; paused mission calls terminate
with an error/timeout, and retry after unpause works. Loading returns a request;
only subsequent lifecycle/log/state evidence establishes actual loading.

Live runtime: returned group names/types match the manifest, positions are measured
by DCS rather than guessed; requested flags reflect actual values. Event monitoring
reports available=false without telemetry. With telemetry, sequence numbers increase,
readout is bounded and oldestSequence exposes lost history. Unknown groups report
exists=false rather than an invented position.

Scenario details: manifest.json contains exact expectedUnits/expectedTasks/triggers,
frequencies, procedure arrays and per-check criteria. Actor positions may differ after
moving; compare initial positions at mission start and routes/tasks subsequently.
Success is outcomeFlag=1; failure=2; unresolved=0. Candidate outcomes are adjudicated
after a one-second window; failure wins within that window. No automatic end is enabled.

A collected log must contain this package's runId and scenarioId marker. A log from
another sortie/package, missing manual results, missing screenshots or pending checks
cannot produce live-pass. Mission Lua errors fail the report. Objective completion
needs a matching objective log marker or correlated runtime outcome, plus operator
attestation. Screenshots are evidence files with hashes, not automatically interpreted
proof of aircraft behavior. The operator must assess their contents.

Positive logistics inventories are a follow-up requiring native wsType-bearing entries.
The default restricted case has EMPTY finite inventories and one InitFuel unit; do not
claim it tests arbitrary positive quantities or resupply chains. Carrier recovery must
be witnessed on the deck; a generic landing event is insufficient.
