/** Supplemental generated pydcs reference; snapshot evidence, not a live DCS database. */
import { readFileSync } from 'node:fs';
import { packagePath } from '../paths.js';
interface AuthoringData {
  _source: string;
  aircraft: Record<string, { pylons: Record<string, string[]>; radioFrequency?: number; liveryName?: string;
    panelRadio?: Record<string, { channels: Record<string, number> }> }>;
  ships: Record<string, { parking: number }>;
  mainTasks: Record<string, { id: number; name: string }>;
  cloudPresets: Record<string, { member: string; uiName: string; description: string; minBase: number; maxBase: number }>;
}
let cached: AuthoringData | undefined;
export function authoringData(): AuthoringData {
  return cached ??= JSON.parse(readFileSync(packagePath('data', 'authoring.json'), 'utf8')) as AuthoringData;
}
