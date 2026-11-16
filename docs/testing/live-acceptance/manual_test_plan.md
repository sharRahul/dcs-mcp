# Exact Windows Mission Editor and flight procedure

1. Build/generate with README commands. Confirm offline-report.json status=pass and
   all ten manifest entries liveStatus=pending. Run Lua compilation with your actual
   interpreter. Save console output. Never run Lua extracted from an untrusted mission.
2. Install hook, restart DCS, open the MCP client and call dcs_bridge_status.
   At menu expect listening=true, phase=menu and missionEnv=false. Record screenshot
   and response. Call dcs_runtime_inspect: expect a clear unavailable/stalled response,
   not fabricated units. Keep raw execution disabled.
3. For each scenario in TEST_MATRIX, open missions/<id>.miz in Mission Editor.
   Compare every manifest.expectedUnits entry (type, name, x/y, skill, heading) and
   expectedTasks route/task against the editor. Inspect coalition/country/date/time,
   weather, briefings, player skill, stores/fuel, frequencies, triggers and goal panels.
   Capture group, task, payload and parking views. Check every ground unit is on land
   and every ship on water; adjust only in a NEW saved mission and document deviations.
4. Fly manually from the DCS mission list. Before takeoff, call dcs_runtime_inspect
   with groups from manifest.groups and flags=[manifest.outcomeFlag]. Expect matching
   acceptance.runId/scenarioId, outcome=0 and available event monitoring. Save JSON.
5. Execute that manifest entry's procedure array in order. Verify each checks[].expected
   statement and capture evidence as it occurs. Do not substitute F10 acknowledgements
   for observing actual AI, carrier, JTAC or warehouse behavior.
6. Verify outcome changes to 1 on victory and is accompanied by an ACCEPTANCE_OBJECTIVE
   victory marker. Replay a separate sortie for failure (outcome=2), and use separate
   evidence directories/results. For branching strike, also replay the late/escalation
   path. State which sortie/outcome each log and screenshot supports.
7. Test bridge reliability on a disposable acceptance sortie: pause, issue a mission
   query and expect an actionable paused/not-ticking error within the deadline; unpause
   and retry. Request named groups/flags and use afterSequence from the previous event
   result. Report missing older events if the bounded ring has advanced past the cursor.
8. Test runtime writes ONLY intentionally in the disposable sortie: send an identifiable
   test message, then spawn ONE catalogued ground type at a confirmed land coordinate
   with a unique name. Verify actual creation and route/state. Retry the same name and
   expect refusal. Do not execute raw Lua. Record all responses and log messages.
9. Safe load test: in menu, loading must refuse. With a disposable mission running,
   explicitly request a generated .miz through dcs_load_mission, poll lifecycle status,
   and inspect log errors. Missing/unreadable or non-.miz paths must fail. The initial
   request is never evidence that the mission completed loading or flew successfully.
10. After each sortie, preserve dcs.log before rotation. Create operator-results.json
    using RESULTS_TEMPLATE. Run acceptance:collect with a NEW evidence directory.
    Without --bridge it still analyzes the correlated log; with --bridge it captures
    read-only status, flags, groups and events. Review evidence-report.json. Pending or
    blocked checks must not be relabelled pass.
11. Preservation test: save an editor-authored donor mission with images, audio,
    warehouse inventory and at least one opaque script/unsupported trigger. Run
    acceptance:check on it. Open/edit one unrelated supported field through MCP, save
    to a NEW path, reopen in ME and compare original resources/unknown fields. Preserve
    both archives and a hash of the source. Unsupported compiled triggers must survive.
12. Warehouse follow-up: case 09 intentionally supplies finite EMPTY stocks, not guessed
    wsType identifiers. In ME create native positive weapon/aircraft entries, save a
    separate donor, inspect with dcs_miz_list_warehouses, then edit existing quantities
    with dcs_miz_edit_warehouse and save a NEW file. Verify depletion and denial in DCS.
    Record the modified mission digest and any deviations from the generated case.

Carrier-specific: the generated F/A-18 has a ship-linked departure, not an AI recovery
route. Fly the landing yourself. A LAND cue from another airfield cannot satisfy the
carrier FEATURE check; require actual arrested-deck evidence. If ME adds a carrier
landing route, save under a new name and document it as a manual addition.

JTAC-specific: inspect the FAC advanced task on JTAC's first waypoint (30 MHz FM).
Use the DCS F10 JTAC menu and confirm real coordination/designation. Dialogue subtitles
alone do not establish JTAC service.

Cinematic-specific: no recorded audio is included. Expect placeholder scripts/subtitles.
To test actual audio, record WAV/OGG, embed via dcs_miz_embed_asset, configure an event
with its real resource key/transmitter zone, save as NEW, then verify playback/frequency
in a separate sortie. Mark fictional dialogue separately from sourced procedures.
