/**
 * Locations of files shipped with the package (the live hook, telemetry script,
 * bundled reference data) and the package version.
 *
 * Both `src/` (run via tsx) and `dist/` (compiled) sit one level below the
 * package root, so the same relative path works from either.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function packagePath(...parts: string[]): string {
  return path.join(PACKAGE_ROOT, ...parts);
}

/** Single source of truth for the version: package.json. */
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(packagePath("package.json"), "utf8")) as { version: string }
).version;
