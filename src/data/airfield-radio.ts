/**
 * Airfield ATC radios and runway designators, generated from pydcs by
 * scripts/gen-airfield-radio.py (data/airfield-radio.json). pydcs exports them from DCS.
 * Runway headings are designator x 10, not measured.
 *
 * Navaids, elevation and ICAO come from DimOn's "Aerodrome Data and Frequencies" kneeboards
 * (scripts/gen-airfield-navaids.py, data/airfield-navaids.json) by OCR, kept only for rows whose
 * OCR'd ATC frequencies equal pydcs's for that airfield and only for values that pass their own
 * format/colour checks. Missing fields mean "not extracted", not "none exists".
 */
import { readFileSync } from 'node:fs';
import { packagePath } from '../paths.js';
import { findAirport, resolveTheatreName } from './reference.js';

interface RunwayEnd { name: string; designatorHeading: number; beaconIds: string[] }
interface AirfieldRadio { name: string; civilian: boolean; atcMHz?: { hf?: number; vhfLow?: number; vhfHigh?: number; uhf?: number };
  runways: { name: string; ends: RunwayEnd[] }[]; beaconIds: string[] }
interface Data { _source: string; theatres: Record<string, Record<string, AirfieldRadio>> }
interface Navaids { icao?: string; elevation?: { ft: number; m: number }; tacan?: string[]; vorMHz?: number[];
  ndbKHz?: number[]; ilsMHz?: number[]; sourcePage: string }
let navCache: { _source: string; theatres: Record<string, Record<string, Navaids>> } | undefined;
const navaids = () => navCache ??= JSON.parse(readFileSync(packagePath('data', 'airfield-navaids.json'), 'utf8'));
let cached: Data | undefined;
const data = () => cached ??= JSON.parse(readFileSync(packagePath('data', 'airfield-radio.json'), 'utf8')) as Data;

export function airfieldRadio(theatre: string, airfield: string | number) {
  const t = resolveTheatreName(theatre) ?? theatre;
  const ap = findAirport(t, airfield);
  const entry = data().theatres[t]?.[String(ap.id)];
  const nav = navaids().theatres[t]?.[String(ap.id)] as Navaids | undefined;
  if (!entry) throw new Error(`No pydcs radio/runway data for ${ap.name} on ${t}`);
  return {
    theatre: t, id: ap.id, name: ap.name, civilian: entry.civilian,
    atcMHz: entry.atcMHz ?? null,
    runways: entry.runways.map(r => ({ name: r.name, ends: r.ends.map(e => ({ name: e.name, designatorHeading: e.designatorHeading })) })),
    navaids: nav ? { icao: nav.icao ?? null, elevation: nav.elevation ?? null, tacan: nav.tacan ?? [], vorMHz: nav.vorMHz ?? [],
      ndbKHz: nav.ndbKHz ?? [], ilsMHz: nav.ilsMHz ?? [], source: `DimOn kneeboard ${nav.sourcePage} (OCR, ATC-gated against pydcs)` } : null,
    notes: ['ATC and runways: pydcs airports export (DCS data).', 'Runway designatorHeading = designator x 10, not a measured heading.',
      ...(entry.atcMHz ? [] : ['pydcs lists no ATC radio for this airfield.']),
      nav ? 'Navaids/elevation/ICAO: OCR of DimOn\'s Aerodrome Data and Frequencies kneeboards (Dima Kozyrev, freeware), kept only where the row\'s ATC frequencies match pydcs; an empty list means not extracted, not absent. ILS frequencies are not tied to a runway. Not ME-verified.'
        : 'No navaid data extracted for this airfield (not in the kneeboard tables, or its row failed the ATC cross-check).'],
  };
}
