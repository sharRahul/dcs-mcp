import { findAirport } from '../data/reference.js';
import type { ScenarioInput } from '../scenario/engine.js';
export interface AcceptanceCase { id: string; title: string; specification: ScenarioInput; procedure: string[]; checks: { id: string; expected: string; screenshot: boolean }[]; limitations: string[] }
/** Exact CLSIDs from the pinned pydcs snapshot; setPayload independently validates each station. */
const AIM9 = '{40EF17B7-F508-45de-8566-6FFECC0C1AB8}', AIM120 = '{5CE2FF2A-645A-4197-B48D-8720AC69394F}', HARM = '{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}';
export function acceptanceCases(): AcceptanceCase[] {
  const ap = findAirport('Caucasus', 'Kutaisi'), p = { x: ap.x, y: ap.y };
  const target = { x: p.x + 40000, y: p.y + 30000 };
  const base = (name: string): ScenarioInput => ({ name, kind: 'cas', theatre: 'Caucasus', seed: 42, coalitions: { blue: ['USA'], red: ['Russia'] }, player: { group: 'Player' }, objective: name,
    durationSeconds: 3600, difficulty: 'normal', threatLevel: 'medium',
    configuration: { date: { year: 2025, month: 6, day: 15 }, startTime: 43200, weather: { atmosphereType: 0, temperatureCelsius: 20, qnhMmHg: 760, visibilityMetres: 80000 } },
    forces: [{ name: 'Player', side: 'blue', country: 'USA', category: 'plane', type: 'F-16C_50', role: 'CAS', position: p, start: { kind: 'parking_hot', airfield: 'Kutaisi' }, frequencyMHz: 251 },
      { name: 'Target', side: 'red', country: 'Russia', category: 'vehicle', type: 'T-72B', count: 3, position: target }],
    victory: [{ kind: 'group_dead', group: 'Target' }], failure: [{ kind: 'unit_dead', unit: 'Player-1' }], endOnOutcome: false,
    assumptions: ['All terrain/deck/module behavior is pending live acceptance. Coordinates are design placements, not terrain-cleared positions.'] });
  const cases: AcceptanceCase[] = [];
  function add(id: string, title: string, spec: ScenarioInput, actions: string[], special: string, limitations: string[] = []) {
    cases.push({ id, title, specification: spec, procedure: actions, limitations,
      checks: [
        { id: 'ME_OPEN', expected: 'Mission opens without a Mission Editor error; compare every unit/position/route with scenario JSON', screenshot: true },
        { id: 'SPAWN', expected: 'Player and expected units spawn; aircraft slots/parking do not overlap; check every ground unit surface', screenshot: true },
        { id: 'TASKS', expected: 'Route/task/radio/payload panels match report; observe role-specific behavior during flight', screenshot: true },
        { id: 'FEATURE', expected: special, screenshot: true },
        { id: 'TRIGGERS', expected: 'Condition-driven events fire once at the declared condition, not before; test failure in a separate sortie', screenshot: true },
        { id: 'RADIO', expected: 'Declared subtitles and F10 entries occur; missing voice is explicitly a placeholder, not playable radio', screenshot: true },
        { id: 'OBJECTIVE', expected: 'Observe victory outcome in runtime flags/log; repeat a separate failure sortie to verify failure handling', screenshot: true },
        { id: 'LOG_CLEAN', expected: 'Correlated session has no mission Lua errors, terrain-water errors or failed framework setup', screenshot: false },
      ] });
  }
  let s = base('F16 SEAD'); s.kind = 'sead'; s.forces[0].role = 'SEAD'; s.forces[0].targetGroup = 'Target';
  s.forces[0].payload = { fuel: 3249, pylons: [{ pylon: 1, CLSID: AIM9 }, { pylon: 2, CLSID: AIM120 }, { pylon: 3, CLSID: HARM }, { pylon: 7, CLSID: HARM }, { pylon: 8, CLSID: AIM120 }, { pylon: 9, CLSID: AIM9 }, { pylon: 10, CLSID: '{AN_ASQ_213}' }] };
  s.forces[1].type = 'Kub 1S91 str'; s.forces[1].site = 'SA-6'; s.forces[1].count = 1;
  s.forces.push({ name: 'PointDefence', side: 'red', country: 'Russia', category: 'vehicle', type: 'Osa 9A33 ln', count: 1, position: { x: target.x + 1000, y: target.y } });
  add('01-f16-sead', 'F-16 SEAD against defended SA-6', s, ['Inspect SA-6 radar/launchers in one group and HARM/HTS stores.', 'Take off; approach the site with radar emission and threat warnings observable.', 'Engage SA-6, record radar/launcher effects, confirm objective. Repeat failure sortie.'], 'SA-6 searches/tracks/engages where DCS geometry permits; F-16 HARM/HTS works; site destruction raises victory', ['Skynet is optional and not bundled; this tests native DCS SAM AI unless explicitly installed/configured.']);
  s = base('F16 CAP'); s.kind = 'defensive_counter_air'; s.forces[0].role = 'BARCAP'; s.forces[0].orbit = { point: { x: p.x + 20000, y: p.y }, point2: { x: p.x + 40000, y: p.y }, pattern: 'Race-Track' };
  s.forces[0].payload = { pylons: [{ pylon: 1, CLSID: AIM9 }, { pylon: 2, CLSID: AIM120 }, { pylon: 8, CLSID: AIM120 }, { pylon: 9, CLSID: AIM9 }] };
  s.forces[1] = { name: 'Target', side: 'red', country: 'Russia', category: 'plane', type: 'MiG-29A', role: 'interception', targetGroup: 'Player', count: 2, position: { x: p.x + 100000, y: p.y + 60000 }, route: [{ x: p.x + 40000, y: p.y + 10000 }] };
  s.forces.push({ name: 'AWACS', side: 'blue', country: 'USA', category: 'plane', type: 'E-3A', role: 'AWACS', count: 1, frequencyMHz: 255, position: { x: p.x - 50000, y: p.y - 20000 }, orbit: { point: { x: p.x - 50000, y: p.y - 20000 }, pattern: 'Circle', altitudeMetres: 8500, speedMps: 180 } }); s.requiredSupport = ['AWACS'];
  add('02-f16-cap', 'F-16 CAP, AWACS and enemy interceptors', s, ['Check CAP racetrack and E-3 AWACS task/frequency.', 'Take off, check in to DCS AWACS, intercept the two MiG-29s.', 'Confirm both-target destruction objective and separately test player loss.'], 'AWACS service and CAP/interceptor behavior work in DCS; this is not inferred from task names');
  s = base('Hornet Carrier'); s.kind = 'carrier_operations'; s.forces[0].type = 'FA-18C_hornet'; s.forces[0].role = 'CAP'; s.forces[0].start = { kind: 'ship_hot', ship: 'Carrier-1' };
  s.forces.push({ name: 'Carrier', side: 'blue', country: 'USA', category: 'ship', type: 'Stennis', count: 1, position: { x: -300000, y: 400000 }, heading: 90, route: [{ x: -300000, y: 450000, speedMps: 10 }] });
  s.victory = [{ kind: 'flag_is_true', flag: 9003 }];
  s.director = { name: 'CarrierOps', channels: [{ id: 'tower', callsign: 'Tower', speaker: 'Carrier controller', frequencyMHz: 251 }], events: [
    { id: 'launch', phase: 'atc_departure', channel: 'tower', when: { worldEvent: { kind: 'takeoff', unit: 'Player-1' } }, template: 'depart', delivery: 'radio' },
    { id: 'recover', phase: 'atc_recovery', channel: 'tower', when: { afterEvent: 'launch', worldEvent: { kind: 'land', unit: 'Player-1' } }, template: 'recover', effects: [{ kind: 'set_flag', flag: 9003, value: 1 }] },
  ] };
  add('03-hornet-carrier', 'F/A-18 carrier departure and manual recovery', s, ['Check Stennis and ship-linked hot start; inspect sea placement and heading/wind.', 'Launch and record takeoff cue, then fly a manual carrier recovery using DCS carrier procedures.', 'Capture arrested landing on the actual carrier. A generic LAND flag alone does not prove carrier recovery.'], 'Actual carrier launch and arrested recovery are observed, with deck/landing screenshots and event evidence', ['No AI/moving-deck recovery waypoint is generated; recovery is a manual piloting test.', 'The LAND cue detects a landing, not proof of landing on this carrier; operator evidence is required.']);
  s = base('CAS JTAC'); s.forces[0].type = 'FA-18C_hornet'; s.forces[0].payload = { pylons: [{ pylon: 2, CLSID: '{DB769D48-67D7-42ED-A2BE-108D566C8B1E}' }, { pylon: 8, CLSID: '{DB769D48-67D7-42ED-A2BE-108D566C8B1E}' }] };
  s.forces.push({ name: 'JTAC', side: 'blue', country: 'USA', category: 'vehicle', type: 'M1043 HMMWV Armament', position: { x: target.x - 3000, y: target.y } });
  add('04-cas-jtac', 'CAS with JTAC and ground targets', s, ['Inspect the generated FAC task on JTAC waypoint 1 (FM 30 MHz).', 'Use DCS F10 JTAC menu; request target information and verify actual designation behavior.', 'Attack the target group with GBU-12s; record coordination and objective result.'], 'JTAC task/F10 coordination and target designation are observed in DCS, not inferred from a fictional dialogue cue', ['FAC task format follows pydcs; actual JTAC availability/designation requires live verification.']);
  s = base('Convoy Ambush'); s.kind = 'convoy_escort'; s.forces[0].role = 'CAP'; s.forces[1].lateActivation = true;
  s.forces.push({ name: 'Convoy', side: 'blue', country: 'USA', category: 'vehicle', type: 'M-1 Abrams', count: 3, position: { x: p.x + 10000, y: p.y + 10000 }, route: [{ x: target.x - 1000, y: target.y, speedMps: 5 }] });
  s.zones = [{ name: 'Ambush', x: target.x - 1000, y: target.y, radius: 2000 }]; s.events = [{ type: 'once', comment: 'Activate ambush', conditions: [{ kind: 'part_of_group_in_zone', group: 'Convoy', zone: 'Ambush' }], actions: [{ kind: 'activate_group', group: 'Target' }, { kind: 'message', text: 'Ambush activated', seconds: 20 }] }];
  add('05-convoy-ambush', 'Convoy with condition-driven ambush', s, ['Verify Target is late activated and Convoy has a route.', 'Observe Convoy reaching Ambush zone; confirm ambushers appear only then.', 'Defend Convoy and destroy Target.'], 'Ambush activates on actual zone entry, exactly once; convoy movement and ground combat are observed', ['Route is straight-leg intent; DCS pathfinding/terrain are unverified.']);
  s = base('Naval Strike'); s.kind = 'naval_strike'; s.forces[0].type = 'FA-18C_hornet'; s.forces[0].role = 'naval_strike'; s.forces[0].targetGroup = 'Target'; s.forces[0].payload = { pylons: [{ pylon: 3, CLSID: '{AGM_84D}' }, { pylon: 7, CLSID: '{AGM_84D}' }] };
  s.forces[1] = { name: 'Target', side: 'red', country: 'Russia', category: 'ship', type: 'MOSCOW', composition: [{ type: 'MOSCOW', count: 1 }, { type: 'REZKY', count: 2 }], position: { x: -300000, y: 350000 }, route: [{ x: -300000, y: 400000, speedMps: 8 }] };
  add('06-naval-strike', 'Naval strike against escorted ships', s, ['Check one ship group has Moskva and two escorts; verify sea placement.', 'Inspect Antiship Strike/AttackGroup task and two AGM-84D stores.', 'Execute strike and record weapons/ship reactions and group-dead objective.'], 'Harpoon employment, escort behavior and ship-group objective are observed in DCS');
  s = base('Branching Strike'); s.kind = 'strike'; s.forces[0].role = 'strike'; s.forces[0].targetGroup = 'Target'; s.forces[0].payload = { pylons: [{ pylon: 3, CLSID: '{BCE4E030-38E9-423E-98ED-24BE3DA87C32}' }, { pylon: 7, CLSID: '{BCE4E030-38E9-423E-98ED-24BE3DA87C32}' }] };
  s.forces.push({ name: 'Reinforce', side: 'red', country: 'Russia', category: 'vehicle', type: 'T-72B', count: 2, position: { x: target.x + 5000, y: target.y }, lateActivation: true });
  s.events = [{ comment: 'Stage one', conditions: [{ kind: 'group_dead', group: 'Target' }], actions: [{ kind: 'set_flag', flag: 9010, value: 1 }, { kind: 'activate_group', group: 'Reinforce' }] },
    { comment: 'Escalation branch', conditions: [{ kind: 'time_after', seconds: 1200 }, { kind: 'flag_is_false', flag: 9010 }], actions: [{ kind: 'activate_group', group: 'Reinforce' }, { kind: 'message', text: 'Escalation: first target remains', seconds: 20 }] }];
  s.victory = [{ kind: 'group_dead', group: 'Target' }, { kind: 'group_dead', group: 'Reinforce' }];
  add('07-branching-strike', 'Multi-stage strike with escalation branch', s, ['Complete Target before 1200s to test the stage-complete reinforcement path.', 'In a second sortie leave Target alive past 1200s to test escalation.', 'Destroy both groups for victory; test player-loss failure separately.'], 'Both declared branches and the ANDed two-group victory condition work in separate recorded sorties');
  for (const [id, title] of [['08-airfield-farp', 'Airfield statics, parking and FARP support'], ['09-logistics', 'Finite airfield logistics']] as const) {
    s = base(id === '08-airfield-farp' ? 'Airfield Support' : 'Limited Logistics'); s.forces[0].role = 'CAS';
    s.events = [{ type: 'start', comment: 'Manual inspection acknowledgement', conditions: [], actions: [{ kind: 'add_radio_item', text: 'Acceptance: ground checks complete', flag: 9020, value: 1 }] }]; s.victory = [{ kind: 'flag_is_true', flag: 9020 }];
    if (id === '08-airfield-farp') s.forces.push({ name: 'Pad', side: 'blue', country: 'USA', category: 'farp', type: 'FARP', position: { x: p.x + 3000, y: p.y + 3000 } },
      { name: 'Huey', side: 'blue', country: 'USA', category: 'helicopter', type: 'UH-1H', role: 'transport', position: p, start: { kind: 'farp_cold', farp: 'Pad' } });
    add(id, title, s, id === '08-airfield-farp' ? ['Inspect parked statics and player slots for overlap.', 'Inspect FARP/helicopter start and support group; verify actual rearm/refuel.', 'Acknowledge the F10 inspection item only after recording all evidence.'] : ['Inspect Kutaisi warehouse flags, fuel and stock quantities in ME.', 'Exhaust a selected finite stock and fuel quantity, then test rearm/refuel denial.', 'Record the warehouse and service evidence; acknowledge F10 only after testing.'], id === '08-airfield-farp' ? 'Statics/parking do not collide; FARP services work with the support group' : 'Finite inventories and fuel restrictions have measurable effects in DCS', ['F10 completion is an operator acknowledgement, not automatic proof of service/logistics behavior.', ...(id === '09-logistics' ? ['New aircraft/weapon wsType entries are not fabricated. Inventory testing requires a native warehouse donor mission; without it this criterion remains blocked.'] : [])]);
  }
  s = base('Cinematic Operation'); s.forces[0].role = 'CAS'; s.forces[0].targetGroup = 'Target';
  s.forces.push({ name: 'AWACS', side: 'blue', country: 'USA', category: 'plane', type: 'E-3A', role: 'AWACS', position: { x: p.x - 40000, y: p.y }, frequencyMHz: 255, orbit: { point: { x: p.x - 40000, y: p.y }, pattern: 'Circle' } }); s.requiredSupport = ['AWACS'];
  s.director = { name: 'Cinematic', channels: [{ id: 'tower', callsign: 'Tower', speaker: 'Controller', frequencyMHz: 251 }, { id: 'awacs', callsign: 'Overlord', speaker: 'AWACS controller', frequencyMHz: 255 }], events: [
    { id: 'briefing', phase: 'briefing', channel: 'tower', when: { atSeconds: 1 }, template: 'check_in', delivery: 'radio' },
    { id: 'departure', phase: 'atc_departure', channel: 'tower', when: { worldEvent: { kind: 'takeoff', unit: 'Player-1' } }, template: 'depart', delivery: 'radio' },
    { id: 'update', phase: 'awacs', channel: 'awacs', when: { afterEvent: 'departure', delaySeconds: 10 }, template: 'contact', delivery: 'radio' },
    { id: 'victory', phase: 'victory', channel: 'awacs', when: { conditions: [{ kind: 'group_dead', group: 'Target' }] }, template: 'success' },
  ] };
  add('10-cinematic', 'Cinematic ATC/AWACS and objective events', s, ['Record briefing, takeoff-triggered departure and tactical update ten seconds later.', 'Destroy Target and record objective-driven victory cue.', 'Review shot list/script/highlight suggestions; optionally record and embed real audio, then repeat.'], 'Actual event/dependency/objective cues match the timeline; no missing audio is reported as playable', ['Dialogue is fictional cinematic material, not authenticated ATC/AWACS procedures.', 'No recorded voice is bundled; subtitles and explicit placeholders are expected.']);
  return cases;
}
