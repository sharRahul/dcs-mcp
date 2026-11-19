/** Reported terrain infrastructure, not SAM equipment layouts or historical orders of battle. */
import { resolveTheatreName } from './reference.js';

export interface TerrainSite {
  id: string; name: string; theatre: string; lat: number; lon: number;
  reportedLayout: string; uncertaintyMetres: number; equipmentFit: 'unverified';
  source: { url: string; author: string; kind: 'community-map-report'; date: string };
  terrainObservation: { build: string; date: string; land: true; sceneryRadiusMetres: number; sceneryObjects: number };
}
const source = { url: 'https://forum.dcs.world/topic/372225-updated-version-on-page-3-marked-up-map-with-sam-sites-air-and-helo-bases-etc/',
  author: 'Essah', kind: 'community-map-report' as const, date: '2025-04-29' };
const sites: TerrainSite[] = [
  { id: 'germany-rostock-sa3', name: 'Rostock coastal site', lat: 54 + 10.164 / 60, lon: 11 + 59.099 / 60, sceneryObjects: 19 },
  { id: 'germany-parchim-sa3', name: 'Parchim west site', lat: 53 + 26.675 / 60, lon: 11 + 39.872 / 60, sceneryObjects: 22 },
  { id: 'germany-wismar-sa3', name: 'Wismar coastal site', lat: 54 + 7.917 / 60, lon: 11 + 40.369 / 60, sceneryObjects: 14 },
  { id: 'germany-rugen-sa3', name: 'Northern Rügen site', lat: 54 + 39.254 / 60, lon: 13 + 15.118 / 60, sceneryObjects: 28 },
].map(({ sceneryObjects, ...s }) => ({ ...s, theatre: 'GermanyCW', reportedLayout: 'SA-3', uncertaintyMetres: 100, equipmentFit: 'unverified', source,
  terrainObservation: { build: '2.9.31.29434', date: '2026-11-19', land: true, sceneryRadiusMetres: 250, sceneryObjects } }));

export function listTerrainSites(theatre?: string, query?: string): TerrainSite[] {
  const canonical = theatre ? resolveTheatreName(theatre) : undefined;
  if (theatre && !canonical) throw new Error(`Unknown theatre '${theatre}'`);
  const q = query?.toLowerCase();
  return sites.filter(s => (!canonical || s.theatre === canonical) && (!q || `${s.id} ${s.name} ${s.reportedLayout}`.toLowerCase().includes(q)))
    .map(s => ({ ...s, source: { ...s.source }, terrainObservation: { ...s.terrainObservation } }));
}
