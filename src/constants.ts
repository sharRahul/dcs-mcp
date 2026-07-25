/** Shared constants for the DCS MCP server. */

/** Maximum characters returned in a single tool response before truncation. */
export const CHARACTER_LIMIT = 25000;

/** Live-bridge defaults. Matches the bundled scripts/Export.lua listener. */
export const BRIDGE_DEFAULT_HOST = "127.0.0.1";
export const BRIDGE_DEFAULT_PORT = 8899;
export const BRIDGE_TIMEOUT_MS = 4000;

/** Archive safety limits applied to every untrusted .miz before extraction. */
export const ARCHIVE_LIMITS = {
  /** Maximum number of entries in the archive. */
  maxEntries: 20000,
  /** Maximum total uncompressed size across all entries (256 MiB). */
  maxTotalUncompressed: 256 * 1024 * 1024,
  /** Maximum uncompressed size of a single entry (64 MiB). */
  maxEntryUncompressed: 64 * 1024 * 1024,
  /** Maximum compression ratio (uncompressed / compressed) for any single entry. */
  maxCompressionRatio: 200,
} as const;

/** Package entries the mission parser reads. Other entries are ignored, never executed. */
export const KNOWN_MIZ_ENTRIES = [
  "mission",
  "options",
  "warehouses",
  "theatre",
  "l10n/DEFAULT/dictionary",
  "l10n/DEFAULT/mapResource",
] as const;

/** Where DCS keeps a mission's localized resources (scripts, sounds, pictures). */
export const L10N_PREFIX = "l10n/DEFAULT/";
