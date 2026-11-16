/**
 * Find third-party unit mods installed on this machine (e.g. a community
 * Su-30MKI), so missions can use them and the validator stops calling their
 * types typos.
 *
 * Mods are Lua, and this server never runs Lua. Their files are scanned as TEXT
 * for the few patterns DCS mods use to declare a unit:
 *   - aircraft:   `make_flyable("TYPE", ...)` and the `Name = "TYPE"` that opens
 *                 an `add_aircraft({ ... })` table,
 *   - ground/ship: `GT.Name = "TYPE"` before `add_surface_unit(GT)`,
 *   - the plugin id from `declare_plugin("ID", ...)`.
 * That is a heuristic, so results say where each type was found. A mod that
 * builds its type names in code will not be seen; pass the type id directly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findSavedGamesDirs } from "./install.js";

export type ModCategory = "plane" | "helicopter" | "vehicle" | "ship" | "unknown";

export interface ModUnit {
  type: string;
  category: ModCategory;
  /** File the declaration was found in, relative to the mod folder. */
  file: string;
}

export interface InstalledMod {
  /** `declare_plugin` id, else the folder name. */
  id: string;
  folder: string;
  /** "aircraft" | "tech" (the Mods/ sub-folder it lives in). */
  kind: string;
  units: ModUnit[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_MOD = 400;

/** Mods/ roots: every Saved Games profile, plus the install dirs in DCS_INSTALL_DIR. */
export function modRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const sg of findSavedGamesDirs(env)) roots.push(path.join(sg.path, "Mods"));
  const install = env.DCS_INSTALL_DIR ? [env.DCS_INSTALL_DIR] : defaultInstallDirs(env);
  for (const dir of install) roots.push(path.join(dir, "Mods"), path.join(dir, "CoreMods"));
  return roots.filter((r) => existsSync(r));
}

function defaultInstallDirs(env: NodeJS.ProcessEnv): string[] {
  const pf = env.ProgramFiles ?? "C:\\Program Files";
  return [
    path.join(pf, "Eagle Dynamics", "DCS World"),
    path.join(pf, "Eagle Dynamics", "DCS World OpenBeta"),
    path.join(pf, "Eagle Dynamics", "DCS World Server"),
  ];
}

function luaFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length >= MAX_FILES_PER_MOD) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      // Liveries, shapes and textures hold no unit declarations.
      if (!/^(liveries|shapes|textures|sounds|cockpit|effects)$/i.test(name)) luaFiles(full, out, depth + 1);
    } else if (name.toLowerCase().endsWith(".lua") && info.size <= MAX_FILE_BYTES) {
      out.push(full);
    }
    if (out.length >= MAX_FILES_PER_MOD) break;
  }
  return out;
}

/** Strip Lua comments so commented-out declarations are not reported. */
function stripComments(src: string): string {
  return src.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/--[^\n]*/g, "");
}

/** Scan one mod folder. Exported for tests. */
export function scanModFolder(folder: string, kind: string): InstalledMod {
  const units = new Map<string, ModUnit>();
  let id = path.basename(folder);
  for (const file of luaFiles(folder)) {
    let src: string;
    try {
      src = stripComments(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const rel = path.relative(folder, file);
    const plugin = src.match(/declare_plugin\s*\(\s*["']([^"']+)["']/);
    if (plugin && path.basename(file).toLowerCase() === "entry.lua") id = plugin[1];

    const add = (type: string, category: ModCategory) => {
      if (!type || type.length > 80) return;
      const existing = units.get(type);
      if (!existing || existing.category === "unknown") units.set(type, { type, category, file: rel });
    };
    for (const m of src.matchAll(/make_flyable\s*\(\s*["']([^"']+)["']/g)) add(m[1], "unknown");
    // add_aircraft({ Name = "X", ... }) or a table assigned earlier and passed in.
    if (/add_aircraft\s*\(/.test(src)) {
      const name = src.match(/\bName\s*=\s*["']([^"']+)["']/);
      if (name) add(name[1], /\bHelicopter\b|helicopter\s*=\s*true|\bis_helicopter\b/i.test(src) ? "helicopter" : "plane");
    }
    if (/add_surface_unit\s*\(/.test(src)) {
      for (const m of src.matchAll(/\bGT\.Name\s*=\s*["']([^"']+)["']/g)) {
        add(m[1], /\bGT\.ship\b|\bShip\b|wsType_Navy|\bNavy\b/.test(src) ? "ship" : "vehicle");
      }
    }
  }
  // make_flyable gives no category; a plane/helicopter seen elsewhere wins.
  return { id, folder, kind, units: [...units.values()] };
}

let cache: { at: number; mods: InstalledMod[] } | undefined;
const CACHE_MS = 60_000;

/** All installed unit mods. Cached for a minute; `refresh` rescans. */
export function installedMods(refresh = false, roots = modRoots()): InstalledMod[] {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.mods;
  const mods: InstalledMod[] = [];
  for (const root of roots) {
    for (const kind of ["aircraft", "tech"]) {
      const dir = path.join(root, kind);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const folder = path.join(dir, name);
        try {
          if (!statSync(folder).isDirectory()) continue;
        } catch {
          continue;
        }
        const mod = scanModFolder(folder, kind);
        if (mod.units.length) mods.push(mod);
      }
    }
  }
  cache = { at: Date.now(), mods };
  return mods;
}

/** Find an installed mod unit by exact type id. */
export function findModUnit(type: string, mods = installedMods()): (ModUnit & { mod: string }) | undefined {
  for (const mod of mods) {
    const unit = mod.units.find((u) => u.type === type);
    if (unit) return { ...unit, mod: mod.id };
  }
  return undefined;
}

/** For tests: drop the scan cache. */
export function clearModCache(): void {
  cache = undefined;
}
