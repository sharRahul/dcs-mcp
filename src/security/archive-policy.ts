/**
 * Archive-safety policy for untrusted `.miz` files.
 *
 * Every mission archive is treated as hostile input. These checks run against the
 * ZIP central directory BEFORE any entry is decompressed, so a malicious archive is
 * rejected without ever allocating its expanded contents (zip-bomb / path-traversal defence).
 */
import path from "node:path";
import { ARCHIVE_LIMITS } from "../constants.js";

export interface EntryHeader {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export class ArchivePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivePolicyError";
  }
}

/** Reject an entry name that escapes the extraction root. */
export function assertSafeEntryName(name: string): void {
  if (name.includes("\0")) {
    throw new ArchivePolicyError(`Archive entry contains a null byte: ${JSON.stringify(name)}`);
  }
  const normalized = name.replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new ArchivePolicyError(`Archive entry uses an absolute path: ${name}`);
  }
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) {
    throw new ArchivePolicyError(`Archive entry uses path traversal ('..'): ${name}`);
  }
}

/** Validate the full entry list against archive limits. Throws on any violation. */
export function assertArchiveWithinLimits(entries: EntryHeader[]): void {
  if (entries.length > ARCHIVE_LIMITS.maxEntries) {
    throw new ArchivePolicyError(
      `Archive has ${entries.length} entries, exceeding the limit of ${ARCHIVE_LIMITS.maxEntries}`
    );
  }

  let total = 0;
  for (const entry of entries) {
    assertSafeEntryName(entry.name);

    if (entry.uncompressedSize > ARCHIVE_LIMITS.maxEntryUncompressed) {
      throw new ArchivePolicyError(
        `Entry '${entry.name}' expands to ${entry.uncompressedSize} bytes, ` +
          `exceeding the per-entry limit of ${ARCHIVE_LIMITS.maxEntryUncompressed}`
      );
    }

    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > ARCHIVE_LIMITS.maxCompressionRatio
    ) {
      throw new ArchivePolicyError(
        `Entry '${entry.name}' has a suspicious compression ratio ` +
          `(${entry.uncompressedSize}/${entry.compressedSize}); possible zip bomb`
      );
    }

    total += entry.uncompressedSize;
    if (total > ARCHIVE_LIMITS.maxTotalUncompressed) {
      throw new ArchivePolicyError(
        `Archive expands to more than ${ARCHIVE_LIMITS.maxTotalUncompressed} bytes total; possible zip bomb`
      );
    }
  }
}
