/** Current-state report; generation/director assets are labelled snapshots, not live state. */
import type { MissionSession } from './sessions.js';
import { asTable, luaArray } from './lua.js';
import { findGroup } from './authoring.js';
import { listAssets } from './assets.js';
import { buildMissionDocument } from './parser.js';
import { validateMission } from './validator.js';
export function missionReport(session: MissionSession) {
  const doc = buildMissionDocument(session.mission, session.dictionary, 'current-session');
  const validation = validateMission(doc, session.mission), assets = listAssets(session);
  return { theatre: doc.theatre, date: session.mission.date, startTime: session.mission.start_time, weather: session.mission.weather,
    coalitions: session.mission.coalitions, bullseyes: Object.fromEntries(['blue', 'red', 'neutrals'].map(side => [side, asTable(asTable(session.mission.coalition)?.[side])?.bullseye ?? null])),
    briefing: doc.briefing, forcedOptions: session.mission.forcedOptions,
    forces: doc.groups.map(g => {
      const raw = findGroup(session.mission, g.name)!.group;
      return { ...g, frequencyMHz: raw.frequency ?? null, lateActivation: raw.lateActivation ?? false, route: raw.route,
        details: luaArray(raw.units).map(u => ({ name: u.name, callsign: u.callsign ?? null, tail: u.onboard_num ?? null, payload: u.payload ?? null })) };
    }), triggers: doc.triggers, goals: session.mission.goals ?? {}, zones: doc.zones, assets,
    dependencies: assets.filter(a => /\.lua$/i.test(a.path)).map(a => ({ ...a, status: 'embedded file only; initialization not inferred' })),
    validation, warnings: validation.warnings.map(w => w.message),
    assumptions: ['No terrain, sensor or runtime execution is inferred from offline data', 'Embedded scenario/director reports are generation snapshots; this report reflects current tables'],
    verification: 'Current offline mission data; no DCS runtime verification' };
}
