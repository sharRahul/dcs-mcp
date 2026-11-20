/**
 * Install the live-control hook (and optionally the in-mission telemetry
 * script) into a DCS "Saved Games" folder.
 *
 * Copying the hook by hand is the most common setup failure: the wrong folder
 * (`DCS` vs `DCS.openbeta`), a missing `Scripts/Hooks` directory, or a stale copy
 * left behind after an upgrade. This finds the candidate folders, creates the
 * directory, and never silently replaces a file that differs from the bundled
 * one — the user may have edited it (e.g. to set `ALLOW_EXEC = true`).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { packagePath } from "../paths.js";

/** Saved Games sub-folders DCS uses, in the order a user most likely means. */
const VARIANTS = ["DCS", "DCS.openbeta", "DCS.server"];

export interface SavedGamesCandidate {
  path: string;
  /** True when the folder looks like a real DCS profile (has Config or Logs). */
  looksLikeDcs: boolean;
}

/** Folders that may be a DCS Saved Games profile. `DCS_SAVED_GAMES` wins if set. */
export function findSavedGamesDirs(env: NodeJS.ProcessEnv = process.env): SavedGamesCandidate[] {
  const explicit = env.DCS_SAVED_GAMES;
  if (explicit) return [{ path: explicit, looksLikeDcs: looksLikeDcs(explicit) }];
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (!home) return [];
  return VARIANTS.map((v) => path.join(home, "Saved Games", v))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, looksLikeDcs: looksLikeDcs(p) }));
}

function looksLikeDcs(dir: string): boolean {
  return existsSync(path.join(dir, "Config")) || existsSync(path.join(dir, "Logs"));
}

export type InstallStatus = "installed" | "unchanged" | "differs" | "replaced" | "would-install" | "would-replace";

export interface InstalledFile {
  file: string;
  target: string;
  status: InstallStatus;
  /** Where the previous file was moved when one was replaced. */
  backup?: string;
}

export interface InstallOptions {
  savedGames: string;
  /** Also copy `dcs-mcp-telemetry.lua` to `Scripts/` for dcs_miz_load_scripts. */
  telemetry?: boolean;
  /** Replace a target that differs from the bundled copy (the old one is backed up). */
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface InstallResult {
  savedGames: string;
  files: InstalledFile[];
  /** True when DCS must be restarted to pick up a new or changed hook. */
  restartRequired: boolean;
  notes: string[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function installOne(
  source: string,
  target: string,
  options: InstallOptions
): Promise<InstalledFile> {
  const file = path.basename(source);
  const bundled = await readFile(source);
  let existing: Buffer | undefined;
  try {
    existing = await readFile(target);
  } catch {
    existing = undefined;
  }

  if (existing && sha256(existing) === sha256(bundled)) return { file, target, status: "unchanged" };
  if (existing && !options.overwrite) return { file, target, status: "differs" };
  if (options.dryRun) return { file, target, status: existing ? "would-replace" : "would-install" };

  await mkdir(path.dirname(target), { recursive: true });
  let backup: string | undefined;
  if (existing) {
    backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(target, backup);
  }
  await copyFile(source, target);
  return { file, target, status: existing ? "replaced" : "installed", backup };
}

export async function installHook(options: InstallOptions): Promise<InstallResult> {
  const info = await stat(options.savedGames).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(
      `'${options.savedGames}' is not a folder. Pass the DCS Saved Games profile, e.g. ` +
        `'C:\\Users\\<you>\\Saved Games\\DCS' (or DCS.openbeta).`
    );
  }
  const notes: string[] = [];
  if (!looksLikeDcs(options.savedGames)) {
    notes.push(
      `'${options.savedGames}' has no Config or Logs folder — DCS may never have run with this profile.`
    );
  }

  const files: InstalledFile[] = [];
  files.push(
    await installOne(
      packagePath('runtime', 'dcs', 'Hooks', "dcs-mcp-hook.lua"),
      path.join(options.savedGames, "Scripts", "Hooks", "dcs-mcp-hook.lua"),
      options
    )
  );
  if (options.telemetry) {
    files.push(
      await installOne(
        packagePath('runtime', 'dcs', 'dcs-mcp-telemetry.lua'),
        path.join(options.savedGames, "Scripts", "dcs-mcp-telemetry.lua"),
        options
      )
    );
  }

  const hook = files[0];
  if (hook.status === "differs") {
    notes.push(
      "The installed hook differs from this version's copy (an older release, or local edits such as " +
        "ALLOW_EXEC). Nothing was changed. Re-run with overwrite to replace it; the old file is kept as a .bak."
    );
  }
  const restartRequired = hook.status === "installed" || hook.status === "replaced";
  if (restartRequired) {
    notes.push(
      "Restart DCS: hooks are read at startup. Then check Logs/dcs.log for " +
        "'hook server listening on 127.0.0.1:8899' with no adjacent ERROR line, or call dcs_bridge_status."
    );
  }
  return { savedGames: options.savedGames, files, restartRequired, notes };
}
