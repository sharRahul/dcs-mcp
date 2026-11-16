# Live coverage matrix

Exact numeric expectations are generated in manifest.json and reports/<id>.json.
Every row requires ME_OPEN, SPAWN, TASKS, FEATURE, TRIGGERS, RADIO, OBJECTIVE and
LOG_CLEAN checks with supporting evidence. No row is live-passed by generation.

| ID | Mission | Primary feature | Required evidence |
|---|---|---|---|
| 01-f16-sead | F-16 SEAD | SA-6 mixed battery plus Osa point defence; HARM/HTS task/loadout | ME group/stores panels; launch/engagement; site damage; outcome flag/log |
| 02-f16-cap | F-16 CAP | Racetrack, E-3 AWACS, two enemy MiG interceptors | ME task/frequency panels; AWACS contact; intercept/kill events |
| 03-hornet-carrier | F/A-18 carrier | Stennis deck start, launch and manually flown recovery | Deck placement, launch, arrested landing on actual carrier, event place if available |
| 04-cas-jtac | CAS | Ground FAC task, FM 30 MHz, GBU-12 targets | JTAC menu/coordination/designation, attack, target objective |
| 05-convoy-ambush | Ground convoy | Actual zone entry activates late ambush once | Route, units before/after activation, zone timing, combat |
| 06-naval-strike | Naval strike | Moskva with two escorts in one group; Harpoon task/loadout | Sea placement, stores/task panels, launch/ship response, group objective |
| 07-branching-strike | Multi-stage strike | Target destruction path vs 1200-second escalation path | Separate sorties for both branches, reinforcement timing, ANDed victory |
| 08-airfield-farp | Airfield/FARP | Parking, three static aircraft, serviced FARP and cold-start Huey | Slot map/no overlap, helicopter start, actual rearm/refuel |
| 09-logistics | Restricted warehouse | Finite empty aircraft/weapons stock and fuel=1 InitFuel | ME warehouse fields, actual depletion/denial; positive-stock follow-up if supplied |
| 10-cinematic | Cinematic mission | Briefing, takeoff event, AWACS update +10s, objective cue | Timeline/flags/subtitles; explicit audio placeholders; shot checklist |

Cross-cutting tests: install/uninstall/restart hook; menu/loading/loaded/running/error
status; paused timeout; current unit/group/flag state; event cursor/ring overrun;
messages and explicitly requested isolated spawn; Mission Editor resave/preservation;
invalid/corrupt mission refusal; source/output identity and copy-on-write behavior.

Optional framework test: use dcs_miz_load_scripts with actual MIST/MOOSE/Skynet files,
configure one IADS, and verify API proof calls plus site counts/telemetry, not just globals.
Framework absence must remain an explicit dependency, never a simulated initialization.
