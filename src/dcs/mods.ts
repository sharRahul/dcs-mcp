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
 *
 * Mods are strictly ADDITIVE. The bundled DCS catalogue (from pydcs) is always
 * consulted first and a mod can never replace or hide one of its types. And
 * discovery can never break anything that works without it: every filesystem
 * error is swallowed and simply yields fewer mods, so validation, saving and
 * every DCS-only workflow behave exactly as if no mods were installed.
 *
 * DEPLOYED vs AVAILABLE. Two different places hold mods, and the difference
 * matters to whoever is building a mission:
 *
 *   - `Mods/aircraft` and `Mods/tech`, under a Saved Games profile or the install:
 *     these are LIVE. DCS loads them, so their types spawn.
 *   - a mod-manager repository - OvGME keeps one folder per mod, holding the tree
 *     it would deploy: `Saved Games/_OvGME Offline Mods/F-22A/f-22a/...`. These are
 *     AVAILABLE but not necessarily enabled. The machine this was written on had
 *     273 units across 32 such folders (an F-22A, a J-20, a Rafale pack, a 166-unit
 *     naval/SAM asset pack) that `Mods/` knew nothing about.
 *
 * Both are scanned, because a type id declared in a repository is still the real
 * id and still better than "probably a typo". But `deployed` says which, and a
 * mission using a type from a mod that is only AVAILABLE will not load until the
 * user enables it - so nothing here pretends the two are the same.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findSavedGamesDirs } from "./install.js";
// Circular with install-info.ts (which imports scanModFolder); both are only called at run time.
import { findInstallDirs } from "./install-info.js";
import { parseSceneryDeclarations } from "./scenery-assets.js";

export type ModCategory = "plane" | "helicopter" | "vehicle" | "ship" | "static" | "unknown";

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
  /** "aircraft" | "tech" for a deployed mod, else the repository folder's name. */
  kind: string;
  /**
   * True when the mod sits in a `Mods/` folder DCS loads. False when it was found
   * in a mod-manager repository: the types are real, but DCS will not spawn them
   * until the mod is enabled.
   */
  deployed: boolean;
  /** The repository it came from, when it is not deployed. */
  repository?: string;
  units: ModUnit[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_MOD = 400;

/** Mods/ roots: every Saved Games profile, plus the install dirs in DCS_INSTALL_DIR. */
export function modRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  for (const sg of findSavedGamesDirs(env)) roots.push(path.join(sg.path, "Mods"));
  // findInstallDirs reads the root DCS logs at startup: with Program Files alone, an install
  // on another drive contributed nothing, and stock CoreMods/tech types (AS32-31A, from the
  // Supercarrier) were reported as "will not spawn here".
  const install = env.DCS_INSTALL_DIR ? [env.DCS_INSTALL_DIR]
    : [...new Set([...findInstallDirs(env).map((d) => d.path), ...defaultInstallDirs(env)])];
  for (const dir of install) roots.push(path.join(dir, "Mods"), path.join(dir, "CoreMods"));
  return roots.filter((r) => existsSync(r));
}

/**
 * Mod-manager repositories: folders that hold mods which are NOT deployed.
 *
 * OvGME names its repository folders itself, so they are matched by shape rather
 * than by a fixed list - any folder beside the DCS profile whose name mentions a
 * mod manager, or that is plainly a mod drop. `DCS_MCP_MOD_REPOS` (a path list)
 * overrides the search entirely for anyone whose layout is different.
 */
export function modRepositoryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.DCS_MCP_MOD_REPOS) {
    return env.DCS_MCP_MOD_REPOS.split(path.delimiter).map((d) => d.trim()).filter((d) => d && existsSync(d));
  }
  const roots: string[] = [];
  // The repositories sit NEXT TO the Saved Games DCS profile, not inside it.
  const parents = new Set<string>();
  for (const sg of findSavedGamesDirs(env)) parents.add(path.dirname(sg.path));
  for (const parent of parents) {
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/ovgme|jsgme|downloaded mods|mod ?repo/i.test(name)) continue;
      const full = path.join(parent, name);
      try {
        if (statSync(full).isDirectory()) roots.push(full);
      } catch {
        continue;
      }
    }
  }
  return roots;
}

export function defaultInstallDirs(env: NodeJS.ProcessEnv): string[] {
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

/**
 * Scan one mod folder. Exported for tests.
 *
 * `deployed` defaults to true because the usual caller is scanning a live
 * `Mods/` folder; a repository scan passes false.
 */
export function scanModFolder(folder: string, kind: string, deployed = true, repository?: string): InstalledMod {
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
    if (/add_personnel\s*\(|add_structure\s*\(|CWAY\s*=/.test(src)) {
      for (const asset of parseSceneryDeclarations(src, file)) add(asset.type, 'static');
    }
    for (const m of src.matchAll(/make_flyable\s*\(\s*["']([^"']+)["']/g)) add(m[1], "unknown");
    // add_aircraft({ Name = "X", ... }) or a table assigned earlier and passed in.
    if (/add_aircraft\s*\(/.test(src)) {
      const name = src.match(/\bName\s*=\s*["']([^"']+)["']/);
      if (name) add(name[1], /\bHelicopter\b|helicopter\s*=\s*true|\bis_helicopter\b/i.test(src) ? "helicopter" : "plane");
    }
    // A ground or ship unit is `GT.Name` plus a registration call. Big mods split
    // the two: HighDigitSAMs defines one unit per file under Database/Vehicles and
    // registers them from a loader elsewhere, so requiring `add_surface_unit` in
    // the SAME file missed every SAM launcher it actually declares. A file that
    // sets `GT.Name` and carries the rest of a ground-unit definition — a display
    // name, a weapon system, or the `GT_t` helper — counts on its own.
    const registersHere = /add_surface_unit\s*\(/.test(src);
    const looksLikeGroundUnit = /\bGT\.DisplayName\b|\bGT\.WS\b|\bGT_t\./.test(src);
    if (registersHere || looksLikeGroundUnit) {
      for (const m of src.matchAll(/\bGT\.Name\s*=\s*["']([^"']+)["']/g)) {
        add(m[1], /\bGT\.ship\b|\bShip\b|wsType_Navy|\bNavy\b/.test(src) ? "ship" : "vehicle");
      }
    }
    // ED's own Supercarrier declares deck equipment through a local helper:
    //   local function support_unit(name, ...) local u = {} ... u.Name = name ... add_surface_unit(u) end
    //   support_unit("AS32-31A", ...)
    // A helper whose body sets <t>.Name from its FIRST parameter and registers <t> declares
    // every string literal it is called with. Read as text, never executed.
    if (registersHere) {
      for (const fn of src.matchAll(/local\s+function\s+(\w+)\s*\(\s*(\w+)[^)]*\)([\s\S]*?)\n\s*end\b/g)) {
        const [, helper, param, body] = fn;
        const named = body.match(new RegExp(`\\b(\\w+)\\.Name\\s*=\\s*${param}\\b`));
        if (!named || !new RegExp(`add_surface_unit\\s*\\(\\s*${named[1]}\\s*\\)`).test(body)) continue;
        for (const call of src.matchAll(new RegExp(`(?<!function\\s)\\b${helper}\\s*\\(\\s*["']([^"']+)["']`, "g"))) add(call[1], "vehicle");
      }
    }
  }
  // make_flyable gives no category; a plane/helicopter seen elsewhere wins.
  return {
    id,
    folder,
    kind,
    deployed,
    ...(repository ? { repository } : {}),
    units: [...units.values()],
  };
}

let cache: { at: number; mods: InstalledMod[] } | undefined;
const CACHE_MS = 60_000;

/** All installed unit mods. Cached for a minute; `refresh` rescans. Never throws. */
export function installedMods(refresh = false, roots?: string[]): InstalledMod[] {
  if (!refresh && !roots && cache && Date.now() - cache.at < CACHE_MS) return cache.mods;
  const mods: InstalledMod[] = [];
  let dirs: string[];
  try {
    dirs = roots ?? modRoots();
  } catch {
    dirs = [];
  }
  for (const root of dirs) {
    for (const kind of ["aircraft", "tech"]) {
      const dir = path.join(root, kind);
      let names: string[];
      try {
        names = existsSync(dir) ? readdirSync(dir) : [];
      } catch {
        continue; // unreadable folder: skip it, never fail the caller
      }
      for (const name of names) {
        const folder = path.join(dir, name);
        try {
          if (!statSync(folder).isDirectory()) continue;
          const mod = scanModFolder(folder, kind);
          if (mod.units.length) mods.push(mod);
        } catch {
          continue;
        }
      }
    }
  }
  // Repositories last, and only for types nothing deployed already declares: a
  // live mod is the better answer for the same id, every time.
  const deployedTypes = new Set(mods.flatMap((m) => m.units.map((u) => u.type)));
  for (const repo of roots ? [] : modRepositoryRoots()) {
    let names: string[];
    try {
      names = readdirSync(repo);
    } catch {
      continue;
    }
    for (const name of names) {
      const folder = path.join(repo, name);
      try {
        if (!statSync(folder).isDirectory()) continue;
        const mod = scanModFolder(folder, path.basename(repo), false, repo);
        mod.units = mod.units.filter((u) => !deployedTypes.has(u.type));
        if (mod.units.length) mods.push(mod);
      } catch {
        continue;
      }
    }
  }
  if (!roots) cache = { at: Date.now(), mods };
  return mods;
}

/** Mods DCS actually loads. */
export function deployedMods(mods = installedMods()): InstalledMod[] {
  return mods.filter((m) => m.deployed);
}

/**
 * Find a mod unit by exact type id.
 *
 * A DEPLOYED mod wins over one that merely sits in a repository, so a type DCS
 * can actually spawn is never reported as unavailable. `deployed` is on the
 * result because the difference decides whether a mission will load.
 */
export function findModUnit(
  type: string,
  mods?: InstalledMod[]
): (ModUnit & { mod: string; deployed: boolean; repository?: string }) | undefined {
  mods ??= installedMods();
  let fallback: (ModUnit & { mod: string; deployed: boolean; repository?: string }) | undefined;
  for (const mod of mods) {
    const unit = mod.units.find((u) => u.type === type);
    if (!unit) continue;
    const hit = { ...unit, mod: mod.id, deployed: mod.deployed, ...(mod.repository ? { repository: mod.repository } : {}) };
    if (mod.deployed) return hit;
    fallback ??= hit;
  }
  return fallback;
}

/** For tests: drop the scan cache. */
export function clearModCache(): void {
  cache = undefined;
}
