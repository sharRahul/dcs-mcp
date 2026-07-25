/**
 * Mission resources: files carried inside the `.miz` and referenced from
 * triggers by a resource key.
 *
 * DCS keeps auxiliary files under `l10n/DEFAULT/` and maps a key to a file name
 * in `l10n/DEFAULT/mapResource`:
 *
 *   mapResource = { ["ResKey_Action_317"] = "mist_4_5_107.lua" }
 *
 * A trigger action then reaches the file through `getValueResourceByKey(...)`,
 * e.g. `a_do_script_file(getValueResourceByKey("ResKey_Action_317"))`. The same
 * mechanism carries sounds (`.ogg`) and pictures. Verified against Mission-Editor
 * -saved missions, including the Skynet and MOOSE demo missions.
 */
import path from "node:path";
import { ARCHIVE_LIMITS, L10N_PREFIX } from "../constants.js";
import { ArchivePolicyError, assertSafeEntryName } from "../security/archive-policy.js";
import type { LuaTable } from "./lua.js";

/** Everything a resource addition touches: the mission table, the map, the files. */
export interface ResourceStore {
  mission: LuaTable;
  mapResource: LuaTable;
  /** Files to embed, keyed by bare file name (no directories). */
  files: Map<string, Buffer>;
}

/**
 * DCS resource keys share `mission.maxDictId` with the dictionary keys, so a
 * mission can carry `DictKey_ActionText_14` and `ResKey_Action_15` without a
 * collision. Allocation just advances the one counter.
 */
export function nextDictId(mission: LuaTable): number {
  const current = mission["maxDictId"];
  const next = (typeof current === "number" ? current : 0) + 1;
  mission["maxDictId"] = next;
  return next;
}

/**
 * A resource file name becomes a ZIP entry, so it must not carry directories or
 * escape `l10n/DEFAULT/`. Rejecting here keeps a caller-supplied path from
 * writing anywhere else in the archive.
 */
export function assertSafeResourceName(fileName: string): void {
  if (!fileName || fileName !== path.basename(fileName)) {
    throw new ArchivePolicyError(
      `Resource file name must be a bare file name without directories: ${JSON.stringify(fileName)}`
    );
  }
  if (fileName === "." || fileName === "..") {
    throw new ArchivePolicyError(`Invalid resource file name: ${JSON.stringify(fileName)}`);
  }
  assertSafeEntryName(`${L10N_PREFIX}${fileName}`);
}

/** Find an existing key already pointing at this file name, so files are embedded once. */
function existingKeyFor(mapResource: LuaTable, fileName: string): string | undefined {
  for (const [key, value] of Object.entries(mapResource)) {
    if (value === fileName) return key;
  }
  return undefined;
}

export interface AddResourceResult {
  key: string;
  fileName: string;
  bytes: number;
  /** True when the file was already present and the existing key was reused. */
  reused: boolean;
}

/**
 * Embed a file in the mission and return its resource key.
 *
 * Re-adding the same file name reuses the existing key rather than embedding a
 * second copy — loading MOOSE twice would both bloat the archive and run the
 * framework's initialisation again.
 */
export function addResource(
  store: ResourceStore,
  fileName: string,
  content: Buffer,
  keyPrefix = "ResKey_Action_"
): AddResourceResult {
  assertSafeResourceName(fileName);

  if (content.byteLength > ARCHIVE_LIMITS.maxEntryUncompressed) {
    throw new ArchivePolicyError(
      `Resource '${fileName}' is ${content.byteLength} bytes, exceeding the per-entry limit ` +
        `of ${ARCHIVE_LIMITS.maxEntryUncompressed}`
    );
  }

  const existing = existingKeyFor(store.mapResource, fileName);
  if (existing) {
    const already = store.files.get(fileName);
    if (already && !already.equals(content)) {
      throw new Error(
        `The mission already carries a different file named '${fileName}'. ` +
          `Rename one of them so both can be embedded.`
      );
    }
    store.files.set(fileName, content);
    return { key: existing, fileName, bytes: content.byteLength, reused: true };
  }

  const key = `${keyPrefix}${nextDictId(store.mission)}`;
  store.mapResource[key] = fileName;
  store.files.set(fileName, content);
  return { key, fileName, bytes: content.byteLength, reused: false };
}

/** Resource keys currently registered, with the file each points at. */
export function listResources(mapResource: LuaTable): { key: string; fileName: string }[] {
  return Object.entries(mapResource)
    .filter(([, v]) => typeof v === "string")
    .map(([key, v]) => ({ key, fileName: v as string }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}
