/**
 * Airfield ATC radios and runway designators, generated from pydcs by
 * scripts/gen-airfield-radio.py (data/airfield-radio.json). pydcs exports them from DCS.
 * Runway headings are designator x 10, not measured; pydcs carries no navaid (TACAN/ILS/
 * VOR/NDB) frequencies, field elevation or magnetic variation, so none are returned.
 */
import { readFileSync } from 'node:fs';
import { packagePath } from '../paths.js';
import { findAirport, resolveTheatreName } from './reference.js';

interface RunwayEnd { name: string; designatorHeading: number; beaconIds: string[] }
interface AirfieldRadio { name: string; civilian: boolean; atcMHz?: { hf?: number; vhfLow?: number; vhfHigh?: number; uhf?: number };
  runways: { name: string; ends: RunwayEnd[] }[]; beaconIds: string[] }
interface Data { _source: string; theatres: Record<string, Record<string, AirfieldRadio>> }
let cached: Data | undefined;
const data = () => cached ??= JSON.parse(readFileSync(packagePath('data', 'airfield-radio.json'), 'utf8')) as Data;

export function airfieldRadio(theatre: string, airfield: string | number) {
  const t = resolveTheatreName(theatre) ?? theatre;
  const ap = findAirport(t, airfield);
  const entry = data().theatres[t]?.[String(ap.id)];
  if (!entry) throw new Error(`No pydcs radio/runway data for ${ap.name} on ${t}`);
  return {
    theatre: t, id: ap.id, name: ap.name, civilian: entry.civilian,
    atcMHz: entry.atcMHz ?? null,
    runways: entry.runways.map(r => ({ name: r.name, ends: r.ends.map(e => ({ name: e.name, designatorHeading: e.designatorHeading })) })),
    navaids: null,
    notes: ['Source: pydcs airports export (DCS data).', 'Runway designatorHeading = designator x 10, not a measured heading.',
      ...(entry.atcMHz ? [] : ['pydcs lists no ATC radio for this airfield.']),
      'TACAN/ILS/VOR/NDB frequencies, field elevation and magnetic variation are not in the bundled data.'],
  };
}
