# Aircraft AI: simulation behavior review

Reviewed 2026-11-17. Scope: DCS behavior, information boundaries, support aircraft,
and verification. This is not a real-world combat doctrine implementation or a
claim that NATO/non-NATO aircraft follow a single common doctrine.

## Findings in this repository

- `src/miz/flight.ts` authors role templates and waypoint tasks. It does not
  implement a runtime pilot decision model. CAP aliases map to CAP, DEAD to SEAD,
  and strike to CAS; these mappings do not establish tactical fidelity.
- `createFlight` adds engagement tasks for CAP/BARCAP/TARCAP/SEAD/DEAD/CAS.
  Its fallback engagement distance is a software default, not sourced aircraft
  performance or doctrine. It must not be presented as such.
- The typed waypoint option interface exposes ROE, reaction, radar and formation.
  Reaction accepts numeric values 0–4. Prefer a version-verified named interface
  before adding behavior presets; preserve existing imported numeric options.
- No `getDetectedTargets` or `isTargetDetected` use was found in production `src`.
  `scripts/dcs-mcp-telemetry.lua` records shot/hit events. An observer's event feed
  is not evidence that every aircraft perceived the event.
- Existing untracked Iron Veil scripts also contain detection/event logic; they
  are separate local work and were not changed or treated as production support.
- `src/miz/transport.ts` wires helicopter/vehicle embark and disembark tasks.
  It explicitly excludes fixed-wing transports and says actual troop carriage
  has not been flown. Do not infer successful loading from task serialization.
- `docs/authoring.md` already distinguishes geometric LOS estimates from sensor
  detection and documents incomplete runtime verification. Retain that distinction.

## Public DCS evidence

1. [Eagle Dynamics detection API](https://www.digitalcombatsimulator.com/en/support/faq/1268/)
   documents controller detection queries and detection methods. A detection
   result must not be expanded into information the result does not provide.
2. [Eagle Dynamics controller API](https://www.digitalcombatsimulator.com/en/support/faq/1267/)
   documents controller tasks and reaction options. Their existence does not
   guarantee identical behavior for every aircraft or DCS version.
3. [DCS User Manual](https://www.digitalcombatsimulator.com/upload/iblock/ed6/87v22jwd1xh51i3rgki944xsf503istq/DCS_User_Manual_EN_2020.pdf)
   describes Mission Editor tasking and defensive options. It is an older
   reference; compare with current editor output and runtime behavior.
4. [Official DCS changelog](https://www.digitalcombatsimulator.com/en/news/changelog/)
   is needed when pinning runtime expectations because native AI changes.

Research limitation: search returned official API excerpts, but direct retrieval
of both API pages returned HTTP 403. No complete current API contract was verified
from those pages. No real-world country doctrine was validated in this review.

## Recommended update boundaries

Keep native DCS responsible for combat maneuvering and weapon employment.
Server improvements should focus on validated task authoring, explicit mission
configuration, observability, support-aircraft lifecycle and reproducible tests.
Do not promise that scripts can remove native AI omniscience or replace its
internal perception and flight control.

For any future information model, separate observer telemetry from actor-visible
observations. Store source, observing unit/group, timestamp, information actually
available and missing fields. Unknown must remain unknown. Never enrich a contact
with exact current world position just because a global object handle exists.
Group controller knowledge must not silently be represented as a particular
crew member's own sensor observation. Any scripted reports need explicit intended
recipients; a shared coalition alone is insufficient evidence of receipt.

Use aircraft capability, mission configuration and supported tasks rather than
NATO/non-NATO labels to select simulation features. Membership is not a sensor
specification. Missing mod capability data should be reported as unknown.

| Role | Appropriate server improvement | Verification boundary |
| --- | --- | --- |
| CAP / interception | Explicit task scope, supported options, route and task logging | Native combat behavior requires live observation; no BVR/dogfight fidelity claim |
| SEAD / ground attack | Validate task compatibility and preserve authored intent | A task label does not prove target identification or successful execution |
| AWACS / tanker | Track service availability, station completion, configured return and landing | Orbit creation alone does not establish usable service |
| Fixed-wing transport | Validate destination, landing route and explicit cargo capability | Transport main task does not implement cargo delivery |
| Helicopter transport | Track pickup, loading, transit, unloading and recovery separately | Require observable loading/unloading evidence; do not equate arrival with success |
| Reconnaissance | Report supported tasking and available observations | Main-task assignment does not create a camera or reconnaissance product |

## Concrete implementation sequence

1. Add documented, named DCS option values after comparing the installed editor's
   saved output with the supported API/catalogue. Report provenance and version.
2. Add support-flight lifecycle reporting: planned, active, on station, returning,
   landed, failed, and unknown. Transitions require observable evidence; authoring
   a route is not evidence of reaching it. Keep return destinations caller supplied.
3. Add transport completion reporting with separate evidence for arrival, loading,
   unloading and recovery. Expose unsupported cargo operations explicitly.
4. Add an observation-only diagnostic adapter before any custom decision layer.
   Verify what detection fields and methods actually return on this DCS build.
   Keep diagnostic world truth separate from the actor-visible data contract.
5. Record configured versus observed behavior in acceptance manifests, including
   DCS build, aircraft type, task configuration, evidence and limitations.

## Acceptance cases

- A globally logged event never appears as every aircraft's observation by default.
- An unavailable observation field stays unavailable; stale contacts are labelled
  with their last observation time rather than refreshed from world truth.
- Equivalent supported configurations are handled consistently across coalitions.
- Unsupported sensors/tasks on a mod produce an explicit capability limitation.
- AWACS/tanker service is checked in DCS, separately from orbit serialization.
- Fixed-wing transport reaches and lands at the configured destination; cargo
  delivery is reported only when a supported mechanism supplies evidence.
- Helicopter pickup/unload is tested for actual troop movement, unavailable pickup
  area, interrupted loading and recovery. Log outcome without assuming success.
- Existing authored options and routes survive save/reopen unchanged unless an
  explicit edit was requested.

No runtime behavior was changed and no live DCS sortie was performed for this review.
