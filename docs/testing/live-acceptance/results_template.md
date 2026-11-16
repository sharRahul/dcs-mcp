# Operator result record

Copy the exact runId from manifest.json. Record DCS version, Windows version, installed
modules, mission filename/hash, date/operator, deviations and which sortie was victory
or failure. Keep the original generated missions and every ME-resaved variant.

Place screenshots next to the results JSON. Evidence paths are relative to the JSON
file's directory; parent traversal/absolute paths are refused. Provide real notes and
at least one evidence file for each pass (including a log screenshot/text extract for
LOG_CLEAN). Do not change pending/blocked to pass without executing the test.

Example operator-results.json (fill ALL eight checks from manifest.scenarios[].checks):

```json
{
  "runId": "<manifest runId>",
  "scenarioId": "01-f16-sead",
  "expectedOutcome": "victory",
  "notes": "DCS version, operator, actual mission filename/hash, deviations, sortie details",
  "checks": [
    {"id": "ME_OPEN", "status": "pending", "notes": "", "evidence": []},
    {"id": "SPAWN", "status": "pending", "notes": "", "evidence": []},
    {"id": "TASKS", "status": "pending", "notes": "", "evidence": []},
    {"id": "FEATURE", "status": "pending", "notes": "", "evidence": []},
    {"id": "TRIGGERS", "status": "pending", "notes": "", "evidence": []},
    {"id": "RADIO", "status": "pending", "notes": "", "evidence": []},
    {"id": "OBJECTIVE", "status": "pending", "notes": "", "evidence": []},
    {"id": "LOG_CLEAN", "status": "pending", "notes": "", "evidence": []}
  ]
}
```

Allowed statuses: pending, blocked, pass, fail. Example completed entry:
`{"id":"SPAWN","status":"pass","notes":"Observed all manifest units at start; no overlap","evidence":["screenshots/spawn.png"]}`.

Run collection separately for success/failure/replay branches, into fresh evidence
directories. Preserve evidence-report.json, source dcs.log, screenshot hashes and runtime
snapshots. A live-pass is an operator-attested result with correlated evidence, not an
automated proof of AI. The single repository verification record is docs/verification.md;
attach these records when asking for it to be updated.
