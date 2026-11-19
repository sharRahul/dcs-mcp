# Production tool contracts

| Stage | Tool | Main inputs |
|---|---|---|
| Plan | dcs_production_create | outputDir (new directory), plan |
| Generate | dcs_production_generate | projectDir, specification (dcs_scenario_validate schema), expectedRevision (0 initially), notes |
| Revise/import | dcs_production_revise | projectDir, sessionId, expectedRevision, notes |
| Validate saved bytes | dcs_production_validate | projectDir, revision |
| Flight evidence | dcs_production_capture | projectDir, revision, optional logPath/host/port |
| Resume/report | dcs_production_status | projectDir |

A plan contains name, theatre, objective, optional assumptions and 1–100 uniquely named checks. Each check has id, description and criterion. Criteria:

- group_exists: group
- group_alive: group (every returned active unit has positive life)
- group_on_ground: group (positive life, active and explicitly not airborne)
- flag_equals: flag, numeric value
- scenario_outcome: value victory/failure; resolves the generated outcome flag from the current Scenario Victory trigger, or stays unknown if no unique flag is available
- event: event (S_EVENT_*), optional initiator/place
- log_clean: no detected problems after the correlated marker
- manual: recorded as unknown by automatic capture

Example plan:

~~~json
{
  "name": "Carrier return", "theatre": "Caucasus",
  "objective": "Observe the AI Hornet return to the intended deck.",
  "checks": [
    {"id":"land", "description":"Hornet lands on Stennis",
     "criterion":{"kind":"event","event":"S_EVENT_LAND","initiator":"Recovery-1","place":"Carrier-1"}},
    {"id":"alive", "description":"Hornet survives on deck",
     "criterion":{"kind":"group_on_ground","group":"Recovery"}}
  ]
}
~~~

The plan cannot be edited in place after generation: changed acceptance criteria require a new project. Revision .miz files are immutable and include a unique filename and start-trigger marker. Validation and evidence bind to the saved archive SHA-256. Manual edits to that archive invalidate its validation/evidence; use an editing session and checkpoint a new revision.

Create/revise operations take a project write lock. A concurrent/stale writer fails instead of overwriting a revision. If a process crashes while holding .write-lock, inspect the project and confirm no writer is running before removing only that lock directory. Interrupted .staging-* folders are not published revisions.

Projects persist on disk independently of MCP session IDs. After restarting the server, dcs_production_status resumes the project; reopen the returned current mission path for an editing session.

Capture does not launch, stop, load or modify DCS. It verifies running identity before and after the native snapshot, requests the plan's groups/flags and retained events, then correlates the latest production marker in a bounded 1 MiB log tail. The report states its correlation strength: mission name + marker + local archive hash is not simulator byte attestation. It records source paths, hashes and raw observations. It does not run mission Lua or accept supplied pass booleans.

States: planned, validation_failed, flight_pending, evidence_partial, declared_checks_observed. New revisions have no inherited flight evidence; prior evidence stays attached to prior revisions. A later observation can establish a previously missing positive event, but qualitative checks remain unknown.

Do not infer all aircraft survived from one returned survivor, or cargo carriage from troop disappearance. A bounded snapshot observes returned units at that moment; use event identity and mission-specific outcome checks for stronger claims. If a check needs details the current API does not supply, report the limitation instead of narrowing the user's requirement silently.

For a generated combat objective, plan a check such as {"id":"win","description":"Victory outcome observed","criterion":{"kind":"scenario_outcome","value":"victory"}}. This avoids predicting allocator flag numbers before generation. The saved revision reports outcomeFlag for inspection. Custom/imported outcome logic without that unambiguous scenario trigger needs an explicit flag_equals criterion or remains unknown.
