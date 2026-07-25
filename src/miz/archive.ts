/**
 * Safe read-only access to `.miz` (ZIP) archives.
 *
 * We never extract to disk and never write to the source archive. Entries are
 * validated against the archive policy, then only the known text entries needed
 * for inspection are decompressed into memory.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import AdmZip from "adm-zip";
import { KNOWN_MIZ_ENTRIES } from "../constants.js";
import {
  ArchivePolicyError,
  assertArchiveWithinLimits,
  assertSafeEntryName,
  type EntryHeader,
} from "../security/archive-policy.js";

export interface MizArchive {
  /** SHA-256 of the raw archive bytes. */
  digest: string;
  /** Raw archive bytes (kept so copy-on-write save preserves unknown entries). */
  bytes: Buffer;
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

  return { digest, bytes, entries, manifest };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy-on-write save: start from `sourceBytes`, replace the given entries, and write
 * a NEW `.miz` at `outPath`. Every other entry is preserved byte-for-byte. Refuses to
 * overwrite the source file. Returns the SHA-256 digest of the new archive.
 */
export async function packMiz(
  sourceBytes: Buffer,
  // Buffers are accepted so binary resources (sounds, pictures) can be embedded
  // alongside the text entries without a lossy round-trip through a string.
  replacements: Map<string, string | Buffer>,
  outPath: string,
  sourcePath?: string,
  overwrite = false
): Promise<{ digest: string; outPath: string }> {
  if (!outPath.toLowerCase().endsWith(".miz")) {
    throw new ArchivePolicyError(`Output path must end in .miz: ${outPath}`);
  }
  if (sourcePath && path.resolve(outPath) === path.resolve(sourcePath)) {
    throw new ArchivePolicyError(
      "Refusing to overwrite the source mission. Choose a different output path (copy-on-write)."
    );
  }
  // Never clobber an unrelated existing mission without being told to.
  if (!overwrite && (await pathExists(outPath))) {
    throw new ArchivePolicyError(
      `Refusing to overwrite the existing file '${outPath}'. ` +
        `Choose a different outPath, or pass overwrite=true if you intend to replace it.`
    );
  }

  const zip = new AdmZip(sourceBytes);
  for (const [name, content] of replacements) {
    assertSafeEntryName(name);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (zip.getEntry(name)) zip.updateFile(name, buf);
    else zip.addFile(name, buf);
  }

  const outBytes = zip.toBuffer();
  await writeFile(outPath, outBytes);
  const digest = createHash("sha256").update(outBytes).digest("hex");
  return { digest, outPath };
}
