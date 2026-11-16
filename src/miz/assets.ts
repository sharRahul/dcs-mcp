/** Mission assets use mapResource or pydcs's KNEEBOARD/<type>/IMAGES path. */
import luaparse from 'luaparse';
import AdmZip from 'adm-zip';
import { basename, extname } from 'node:path';
import { asTable, type LuaTable, type LuaValue } from './lua.js';
import { addResource, assertSafeResourceName } from './resources.js';
import type { MissionSession } from './sessions.js';
import { ARCHIVE_LIMITS } from '../constants.js';
import { assertSafeEntryName } from '../security/archive-policy.js';
import { findUnitType } from '../data/reference.js';
export type AssetKind = 'audio' | 'briefing_image' | 'kneeboard' | 'script' | 'media';
export function readAssetBytes(session: MissionSession, path: string) {
  if (session.removedEntries?.has(path)) return undefined;
  return session.archiveFiles?.get(path) ?? (path.startsWith('l10n/DEFAULT/') ? session.files.get(path.slice(13)) : undefined) ?? new AdmZip(session.sourceBytes).getEntry(path)?.getData();
}
export function embedAsset(session: MissionSession, kind: AssetKind, fileName: string, bytes: Buffer, side: 'blue' | 'red' | 'neutrals' = 'blue', aircraft?: string) {
  assertSafeResourceName(fileName);
  if (!bytes.length || bytes.length > ARCHIVE_LIMITS.maxEntryUncompressed) throw new Error('Asset is empty or exceeds the archive member size limit');
  const ext = extname(fileName).toLowerCase();
  if (['briefing_image', 'kneeboard'].includes(kind) && !['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('Images require PNG/JPEG files');
  if (kind === 'audio' && !['.wav', '.ogg'].includes(ext)) throw new Error('Audio requires WAV/OGG files');
  if (kind === 'script' && ext !== '.lua') throw new Error('Script assets require .lua files');
  if (kind === 'script') luaparse.parse(bytes.toString('utf8'), { luaVersion: '5.1' });
  let path: string;
  if (kind === 'kneeboard') {
    if (!aircraft || /[\\/]/.test(aircraft) || !['plane', 'helicopter'].includes(findUnitType(aircraft)?.category ?? '')) throw new Error('Kneeboard requires a known aircraft id usable as one path segment');
    path = `KNEEBOARD/${aircraft}/IMAGES/${fileName}`;
  } else path = `l10n/DEFAULT/${fileName}`;
  assertSafeEntryName(path);
  const existing = readAssetBytes(session, path);
  if (existing && !existing.equals(bytes)) throw new Error('A different asset already uses this archive path; rename the new file');
  let key: string | undefined;
  if (kind === 'kneeboard') {
    (session.archiveFiles ??= new Map()).set(path, bytes);
  } else {
    const resource = addResource(session, fileName, bytes); key = resource.key;
    if (kind === 'briefing_image') {
      const field = { blue: 'pictureFileNameB', red: 'pictureFileNameR', neutrals: 'pictureFileNameN' }[side];
      const pictures = (session.mission[field] ??= {}) as LuaTable;
      if (!Object.values(pictures).includes(key)) pictures[Math.max(0, ...Object.keys(pictures).map(Number).filter(Number.isFinite)) + 1] = key;
    }
  }
  session.removedEntries?.delete(path);
  return { path, ...(key ? { resourceKey: key } : {}), bytes: bytes.length, kind, verification: 'embedded only; media decoding and DCS display/playback unverified' };
}
export function listAssets(session: MissionSession) {
  const source = new Map(new AdmZip(session.sourceBytes).getEntries().filter(e => !e.isDirectory).map(e => [e.entryName, e.header.size]));
  const paths = new Set(source.keys());
  for (const name of session.files.keys()) paths.add(`l10n/DEFAULT/${name}`);
  for (const name of session.archiveFiles?.keys() ?? []) paths.add(name);
  for (const name of session.removedEntries ?? []) paths.delete(name);
  return [...paths].filter(p => p.startsWith('KNEEBOARD/') || (p.startsWith('l10n/') && !/\/(dictionary|mapResource)$/.test(p))).sort().map(path => ({ path,
    keys: Object.entries(session.mapResource).filter(([, v]) => path === `l10n/DEFAULT/${v}`).map(([k]) => k),
    bytes: session.archiveFiles?.get(path)?.length ?? (path.startsWith('l10n/DEFAULT/') ? session.files.get(path.slice(13))?.length : undefined) ?? source.get(path) ?? null }));
}
export function removeAsset(session: MissionSession, path: string, force = false) {
  assertSafeEntryName(path);
  if (!listAssets(session).some(a => a.path === path)) throw new Error('No removable asset at this path');
  const keys = Object.entries(session.mapResource).filter(([, v]) => path === `l10n/DEFAULT/${v}`).map(([k]) => k);
  const references: string[] = [];
  function scan(value: LuaValue | undefined, location: string, depth = 0) {
    if (depth > 50) throw new Error('Mission nesting too deep to prove resource is unused');
    if (typeof value === 'string' && [...keys, path, basename(path)].some(k => value.includes(k))) references.push(location);
    const table = asTable(value); if (table) for (const [k, v] of Object.entries(table)) scan(v, `${location}.${k}`, depth + 1);
  }
  scan(session.mission, 'mission');
  if (references.length && !force) throw new Error(`Asset is referenced at ${references.slice(0, 10).join(', ')}; remove references first or use force to leave dangling references`);
  for (const key of keys) delete session.mapResource[key];
  if (path.startsWith('l10n/DEFAULT/')) session.files.delete(path.slice(13));
  session.archiveFiles?.delete(path); (session.removedEntries ??= new Set()).add(path);
  return { removed: path, references, warning: references.length ? 'Forced removal leaves unresolved references; repair before flying' : 'No mission-table references found; indirect references inside opaque scripts/media cannot be proven absent' };
}
