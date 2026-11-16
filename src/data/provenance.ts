/**
 * One registry for every bundled dataset: what generated it, from which upstream source and
 * licence, how its inputs are pinned, and what it has (and has not) been verified against.
 * tests/provenance.test.ts fails if a data/*.json file is missing here or lacks its pins.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { packagePath } from '../paths.js';

export interface Dataset {
  file: string; generator: string; upstream: string; licence: string;
  /** The metadata field that pins the inputs, and what kind of pin it is. */
  pins: { field: string; kind: 'sha256' | 'wiki-revid' | 'image-sha256' };
  regenerate: string; verification: string;
}

export const DATASETS: Dataset[] = [
  { file: 'countries.json', generator: 'scripts/gen-reference-data.py', upstream: 'pydcs 1.0.0 (exported by pydcs from DCS)', licence: 'LGPL-3.0-or-later',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'python3 -I scripts/gen-reference-data.py <pydcs-1.0.0 wheel dir> data',
    verification: 'Byte-reproducible from the pinned pydcs files; not checked against a DCS install.' },
  { file: 'unit-types.json', generator: 'scripts/gen-reference-data.py', upstream: 'pydcs 1.0.0', licence: 'LGPL-3.0-or-later',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'python3 -I scripts/gen-reference-data.py <pydcs dir> data',
    verification: 'Byte-reproducible from pinned pydcs; fuel maxima are pydcs fuel_max.' },
  { file: 'theatres.json', generator: 'scripts/gen-reference-data.py', upstream: 'pydcs 1.0.0', licence: 'LGPL-3.0-or-later',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'python3 -I scripts/gen-reference-data.py <pydcs dir> data',
    verification: 'Byte-reproducible; projection pinned to pyproj output in tests/editing.test.ts.' },
  { file: 'authoring.json', generator: 'scripts/gen-authoring-data.py', upstream: 'pydcs 1.0.0 (weapons, planes, helicopters, ships, cloud presets, tasks)', licence: 'LGPL-3.0-or-later',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'python3 -I scripts/gen-authoring-data.py <pydcs dir> data/authoring.json',
    verification: 'Byte-reproducible from pinned pydcs.' },
  { file: 'airfield-radio.json', generator: 'scripts/gen-airfield-radio.py', upstream: 'pydcs 1.0.0 terrain/*/airports.py', licence: 'LGPL-3.0-or-later',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'python3 -I scripts/gen-airfield-radio.py <pydcs dir> data/airfield-radio.json',
    verification: 'Byte-reproducible; runway headings are designator x 10.' },
  { file: 'hoggit.json', generator: 'scripts/gen-hoggit-data.py', upstream: 'Hoggit DCS wiki (wiki.hoggitworld.com), facts only', licence: 'none stated; facts only, no prose',
    pins: { field: '_revisions', kind: 'wiki-revid' }, regenerate: 'python3 -I scripts/gen-hoggit-data.py --fetch <cache> data/hoggit.json',
    verification: 'Scripting-API documentation; cross-checked against ED manual menus; not ME-verified.' },
  { file: 'radio-bands.json', generator: 'scripts/gen-radio-bands.py', upstream: "Hoggit DCS wiki '<type> Radios' pages", licence: 'none stated; facts only',
    pins: { field: 'aircraft.*.revid', kind: 'wiki-revid' }, regenerate: 'python3 -I scripts/gen-radio-bands.py data/authoring.json data/radio-bands.json',
    verification: 'A radio gets a band only when all pydcs default channels fit exactly one documented band.' },
  { file: 'me-manual-actions.json', generator: 'scripts/gen-me-manual-actions.py', upstream: "ED's DCS User Manual PDF (2022-07-27)", licence: 'ED document; menu labels only',
    pins: { field: '_sha256', kind: 'sha256' }, regenerate: 'pdftotext -layout <pdf> m.txt && python3 -I scripts/gen-me-manual-actions.py m.txt <pdf sha256> data/hoggit.json data/me-manual-actions.json',
    verification: 'Labels linked by literal name only.' },
  { file: 'airfield-navaids.json', generator: 'scripts/gen-airfield-navaids.py', upstream: "DimOn 'Aerodrome Data and Frequencies' (01 Feb 2026, freeware), OCR", licence: 'Freeware, unlimited distribution',
    pins: { field: '_images_sha256', kind: 'image-sha256' }, regenerate: 'ocrenv/bin/python -I scripts/gen-airfield-navaids.py "docs/aerodrome data_01-feb-2026" data/airfield-radio.json data/airfield-navaids.json',
    verification: 'Rows kept only when OCR ATC frequencies equal pydcs; spot-checked against the page images.' },
  { file: 'real-world-inventory.json', generator: 'scripts/gen-real-world-inventory.py', upstream: 'English Wikipedia equipment lists', licence: 'CC BY-SA 4.0',
    pins: { field: '_revisions', kind: 'wiki-revid' }, regenerate: 'python3 -I scripts/gen-real-world-inventory.py ... then scripts/pin-wikipedia-revisions.py',
    verification: 'Revisions pinned after generation (same day); pages edited that day are flagged mayPostdateGeneration.' },
];

function pinCount(data: Record<string, unknown>, d: Dataset): number {
  if (d.pins.field === 'aircraft.*.revid') return Object.values((data.aircraft ?? {}) as Record<string, { revid?: number }>).filter(a => Number.isInteger(a.revid)).length;
  const v = data[d.pins.field] as Record<string, unknown> | string | undefined;
  if (!v) return 0;
  if (typeof v === 'string') return /^[0-9a-f]{64}$/.test(v) ? 1 : 0;
  if (d.file === 'real-world-inventory.json') return Object.values((v.pages ?? {}) as Record<string, { revid?: number }>).filter(p => Number.isInteger(p.revid)).length;
  return Object.keys(v).length;
}

export function provenanceReport() {
  const files = readdirSync(packagePath('data')).filter(f => f.endsWith('.json')).sort();
  const registered = new Set(DATASETS.map(d => d.file));
  return {
    unregistered: files.filter(f => !registered.has(f)),
    datasets: DATASETS.map(d => {
      const raw = readFileSync(packagePath('data', d.file));
      const data = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      return { ...d, fileSha256: createHash('sha256').update(raw).digest('hex'), source: String(data._source ?? ''), pinnedInputs: pinCount(data, d) };
    }),
  };
}
