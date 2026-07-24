/**
 * Safe read-only access to `.miz` (ZIP) archives.
 *
 * We never extract to disk and never write to the source archive. Entries are
 * validated against the archive policy, then only the known text entries needed
 * for inspection are decompressed into memory.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AdmZip from "adm-zip";
import { KNOWN_MIZ_ENTRIES } from "../constants.js";
import {
  ArchivePolicyError,
  assertArchiveWithinLimits,
  type EntryHeader,
} from "../security/archive-policy.js";

export interface MizArchive {
  /** SHA-256 of the raw archive bytes. */
  digest: string;
  /** Decompressed text of known entries, keyed by entry name. */
  entries: Map<string, string>;
  /** Header info for every entry (names/sizes only, no data). */
  manifest: EntryHeader[];
}

/** Read and validate a `.miz` file, decompressing only the known data entries. */
export async function readMizArchive(filePath: string): Promise<MizArchive> {
  if (!filePath.toLowerCase().endsWith(".miz")) {
    throw new ArchivePolicyError(`Not a .miz file: ${filePath}`);
  }

  const bytes = await readFile(filePath);
  const digest = createHash("sha256").update(bytes).digest("hex");

  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch (err) {
    throw new ArchivePolicyError(
      `Not a valid ZIP archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const zipEntries = zip.getEntries();
  const manifest: EntryHeader[] = zipEntries.map((e) => ({
    name: e.entryName,
    compressedSize: e.header.compressedSize,
    uncompressedSize: e.header.size,
  }));

  // Enforce all safety limits before decompressing anything.
  assertArchiveWithinLimits(manifest);

  const entries = new Map<string, string>();
  const known = new Set<string>(KNOWN_MIZ_ENTRIES);
  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    if (!known.has(entry.entryName)) continue; // only read entries we understand
    entries.set(entry.entryName, entry.getData().toString("utf8"));
  }

  return { digest, entries, manifest };
}
