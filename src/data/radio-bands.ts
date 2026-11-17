/** Documented radio bands (data/radio-bands.json, scripts/gen-radio-bands.py). Today: A-10C only. */
import { readFileSync } from 'node:fs';
import { packagePath } from '../paths.js';

export interface Band { band: string; minMHz: number; maxMHz: number }
interface Data { _source: string; aircraft: Record<string, { page: string; revid: number; radios: Record<string, Band | null> }> }
let cached: Data | undefined;
const data = () => cached ??= JSON.parse(readFileSync(packagePath('data', 'radio-bands.json'), 'utf8')) as Data;

/** The documented band of one preset radio, or undefined when none is sourced. */
export function radioBand(type: string, radio: number | string): (Band & { page: string }) | undefined {
  const entry = data().aircraft[type];
  const band = entry?.radios[String(radio)];
  return band ? { ...band, page: entry.page } : undefined;
}
export function bandedTypes(): string[] { return Object.keys(data().aircraft); }
