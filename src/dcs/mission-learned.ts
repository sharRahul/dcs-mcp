/**
 * Learn unit types, and the stores they actually carry, from missions the user
 * supplies.
 *
 * The bundled catalogue is pinned to pydcs 1.0.0, and three separate things fall
 * outside it:
 *
 *   - **Stock types newer than the pin.** `Oil rig`, the carrier deck crew,
 *     `FARP_SINGLE_01`, `AS32-p25` and a few dozen more are plain DCS statics
 *     that pydcs 1.0.0 does not list. 145 distinct unknown types turned up across
 *     one corpus of editor-saved missions.
 *   - **Mods whose declarations cannot be read.** `src/dcs/mods.ts` scans mod Lua
 *     as text, which works for `make_flyable`, `add_aircraft` and `GT.Name`
 *     definitions - but the Su-35 mod registers its type from COMPILED Lua
 *     (`Su35s_encrypt.lua`, LuaQ bytecode), so no text scan will ever find it.
 *   - **Mods that are not installed here at all.** A mission built on someone
 *     else's machine names `Su-30MKI`, `Su-30SM`, `J-20X`, `Rafale_C`; those ids
 *     are real for whoever flies that mission even though nothing locally
 *     declares them.
 *
 * A type sitting in a Mission-Editor-saved mission is evidence the id exists and
 * evidence of which category DCS files it under. The CLSIDs on its pylons are
 * evidence of what that airframe can carry, which is exactly the data a mod
 * brings and that no catalogue here has.
 *
 * What a learned type is NOT: it carries no catalogue facts. No `fuel_max`, no
 * dimensions to fit a parking slot, no task list, no pylon validation. Anything
 * that needs those must treat a learned type as unknown rather than assume a
 * default, and `learnedTypeSource` marks every entry so callers can.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readMizArchive } from "../miz/archive.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "../miz/lua.js";
import { findUnitType, registerTypeSource, type FlyingType, type NamedType, type StaticType, type UnitCategory } from "../data/reference.js";
import { findModUnit } from "./mods.js";

export const LEARNED_PACK_FORMAT = "dcs-mcp-learned-types/1";

/** Where a learned type came from and how strong the evidence is. */
export interface LearnedType {
  type: string;
  /** Where the mission tree kept it; this IS the DCS category. */
  category: UnitCategory;
  /** The `category` field a static unit carries ('Fortifications', 'Effects', ...). */
  staticCategory?: string;
  /** `shape_name`, when the missions agreed on one. */
  shapeName?: string;
  /** Total units of this type seen. */
  units: number;
  /** How many distinct missions carried it: the real measure of confidence. */
  missions: number;
  /** A mod installed on this machine that declares the id, when one does. */
  declaredByMod?: string;
  /** CLSIDs seen on its pylons, i.e. what it was actually flown with. */
  stores?: string[];
  /** Livery names seen on it. */
  liveries?: string[];
  /** `rate` (score for killing it) where the missions agreed. */
  rate?: number;
  /** Example mission file names, for a human to go and look. */
  examples: string[];
}

export interface LearnedPack {
  format: typeof LEARNED_PACK_FORMAT;
  name: string;
  createdAt: string;
  /** Mission files read, with their sha256: the provenance of every entry. */
  sources: { file: string; sha256: string }[];
  types: LearnedType[];
  notes: string[];
}

export function learnedDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DCS_MCP_LEARNED_DIR) return env.DCS_MCP_LEARNED_DIR;
  const base = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "dcs-mcp") : path.join(homedir(), ".dcs-mcp");
  return path.join(base, "learned-types");
}

const safeName = (name: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/.test(name)) throw new Error("Pack name: 1-48 letters, digits, space, _ . -");
  return name;
};
const fileFor = (dir: string, name: string) => path.join(dir, `${safeName(name).replace(/[ .]/g, "_")}.json`);

// --- learning --------------------------------------------------------------

export interface LearnArgs {
  /** Folders of .miz files to read. Nothing is written to them. */
  folders: string[];
  /** Pack name to store under; omit to scan without saving. */
  name?: string;
  /** Include types the bundled catalogue already knows (default: only unknown ones). */
  includeKnown?: boolean;
  /** Smallest number of distinct missions a type must appear in to be kept. */
  minMissions?: number;
  overwrite?: boolean;
  dir?: string;
}

interface Accumulator {
  category: UnitCategory;
  staticCategories: Map<string, number>;
  shapes: Map<string, number>;
  units: number;
  missions: Set<string>;
  stores: Set<string>;
  liveries: Set<string>;
  rates: Map<number, number>;
}

function listMiz(folder: string, acc: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = path.join(folder, entry.name);
    if (entry.isDirectory()) listMiz(p, acc);
    else if (entry.name.toLowerCase().endsWith(".miz")) acc.push(p);
  }
  return acc;
}

const CATEGORIES: UnitCategory[] = ["plane", "helicopter", "vehicle", "ship", "static"];

/** Most common value in a counted map, when one is clearly the agreed answer. */
function agreed<T>(counts: Map<T, number>): T | undefined {
  if (!counts.size) return undefined;
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

export async function learnFromMissions(args: LearnArgs): Promise<{ pack: LearnedPack; storedAt?: string; unreadable: string[] }> {
  const minMissions = args.minMissions ?? 1;
  const files = args.folders.flatMap((f) => listMiz(f));
  if (!files.length) throw new Error(`No .miz files found under ${args.folders.join(", ")}`);
  const found = new Map<string, Accumulator>();
  const sources: { file: string; sha256: string }[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    let mission: LuaTable;
    let digest: string;
    try {
      const archive = await readMizArchive(file);
      const text = archive.entries.get("mission");
      if (!text) {
        unreadable.push(path.basename(file));
        continue;
      }
      digest = archive.digest;
      mission = parseLuaAssignment(text, "mission");
    } catch (error) {
      unreadable.push(`${path.basename(file)}: ${(error as Error).message.slice(0, 80)}`);
      continue;
    }
    const base = path.basename(file);
    sources.push({ file: base, sha256: digest });

    for (const side of ["blue", "red", "neutrals"] as const) {
      for (const country of luaArray(asTable(asTable(mission["coalition"])?.[side])?.["country"])) {
        for (const category of CATEGORIES) {
          for (const group of luaArray(asTable(country[category])?.["group"])) {
            for (const unit of luaArray(asTable(group["units"]))) {
              const type = String(unit["type"] ?? "");
              if (!type) continue;
              if (!args.includeKnown && findUnitType(type)) continue;
              const hit =
                found.get(type) ??
                found
                  .set(type, {
                    category,
                    staticCategories: new Map(),
                    shapes: new Map(),
                    units: 0,
                    missions: new Set(),
                    stores: new Set(),
                    liveries: new Set(),
                    rates: new Map(),
                  })
                  .get(type)!;
              hit.units++;
              hit.missions.add(base);
              // A static placed as a parked aircraft shows up under `static`; the
              // flying category wins, because that is what the id really is.
              if (hit.category === "static" && category !== "static") hit.category = category;
              const staticCategory = unit["category"];
              if (typeof staticCategory === "string") {
                hit.staticCategories.set(staticCategory, (hit.staticCategories.get(staticCategory) ?? 0) + 1);
              }
              const shape = unit["shape_name"];
              if (typeof shape === "string") hit.shapes.set(shape, (hit.shapes.get(shape) ?? 0) + 1);
              const rate = unit["rate"];
              const rateNumber = typeof rate === "number" ? rate : typeof rate === "string" ? Number(rate) : NaN;
              if (Number.isFinite(rateNumber)) hit.rates.set(rateNumber, (hit.rates.get(rateNumber) ?? 0) + 1);
              const livery = unit["livery_id"];
              if (typeof livery === "string" && livery) hit.liveries.add(livery);
              for (const pylon of Object.values(asTable(asTable(unit["payload"])?.["pylons"]) ?? {})) {
                const clsid = asTable(pylon)?.["CLSID"];
                if (typeof clsid === "string" && clsid) hit.stores.add(clsid);
              }
            }
          }
        }
      }
    }
  }

  const types: LearnedType[] = [];
  for (const [type, hit] of found) {
    if (hit.missions.size < minMissions) continue;
    const mod = findModUnit(type);
    types.push({
      type,
      category: hit.category,
      ...(agreed(hit.staticCategories) ? { staticCategory: agreed(hit.staticCategories) } : {}),
      ...(agreed(hit.shapes) ? { shapeName: agreed(hit.shapes) } : {}),
      units: hit.units,
      missions: hit.missions.size,
      ...(mod ? { declaredByMod: mod.mod ?? "mod" } : {}),
      ...(hit.stores.size ? { stores: [...hit.stores].sort() } : {}),
      ...(hit.liveries.size ? { liveries: [...hit.liveries].sort().slice(0, 40) } : {}),
      ...(agreed(hit.rates) !== undefined ? { rate: agreed(hit.rates) } : {}),
      examples: [...hit.missions].slice(0, 3),
    });
  }
  types.sort((a, b) => b.missions - a.missions || b.units - a.units);

  const pack: LearnedPack = {
    format: LEARNED_PACK_FORMAT,
    name: args.name ?? "scan",
    createdAt: new Date().toISOString(),
    // Capped: the provenance matters, a 3000-entry list in every response does not.
    sources: sources.slice(0, 200),
    types,
    notes: [
      `Learned from ${sources.length} mission file(s); every type below was placed by whoever built those missions.`,
      "A learned type carries NO catalogue facts: no maximum fuel, no dimensions for parking, no task list, no pylon validation.",
      "`stores` is what the airframe was actually flown with in those missions - the closest thing to a mod's own weapon list that a mission file can give.",
      "`missions` is the confidence measure: a type in one mission may be a typo, a type in ten is real.",
      "Nothing here says the type is installed on THIS machine. `declaredByMod` is set only when a local mod declares the id.",
    ],
  };

  if (!args.name) return { pack, unreadable };
  const dir = args.dir ?? learnedDir();
  const target = fileFor(dir, args.name);
  if (existsSync(target) && !args.overwrite) throw new Error(`Learned pack '${args.name}' already exists; pass overwrite`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, JSON.stringify(pack, null, 1), "utf8");
  return { pack, storedAt: target, unreadable };
}

// --- storage ---------------------------------------------------------------

export function loadLearnedPacks(dir = learnedDir()): LearnedPack[] {
  let files: string[] = [];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  } catch {
    return [];
  }
  const out: LearnedPack[] = [];
  for (const file of files) {
    try {
      const pack = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as LearnedPack;
      if (pack.format === LEARNED_PACK_FORMAT && Array.isArray(pack.types)) out.push(pack);
    } catch {
      /* an unreadable pack is skipped, never fatal */
    }
  }
  return out;
}

export function removeLearnedPack(name: string, dir = learnedDir()): { removed: string } {
  const file = fileFor(dir, name);
  if (!existsSync(file)) throw new Error(`No learned pack '${name}'`);
  rmSync(file);
  return { removed: name };
}

/** Every learned type across every pack, the better-attested entry winning. */
export function learnedTypes(dir = learnedDir()): Map<string, LearnedType & { pack: string }> {
  const out = new Map<string, LearnedType & { pack: string }>();
  for (const pack of loadLearnedPacks(dir)) {
    for (const type of pack.types) {
      const existing = out.get(type.type);
      if (!existing || type.missions > existing.missions) out.set(type.type, { ...type, pack: pack.name });
    }
  }
  return out;
}

/** sha256 of a pack's type list, so two machines can compare what they learned. */
export function learnedFingerprint(pack: LearnedPack): string {
  return createHash("sha256")
    .update(JSON.stringify(pack.types.map((t) => [t.type, t.category, t.stores ?? []])))
    .digest("hex")
    .slice(0, 16);
}

// --- registration ----------------------------------------------------------

/**
 * Make every learned type findable by `findUnitType`, so authoring can place a
 * mod airframe or a post-pydcs static instead of refusing it.
 *
 * Catalogue fields are left NULL rather than guessed. A learned flying type has
 * no `fuelMax`, so `addAircraftGroup` writes no `payload.fuel` and DCS applies
 * its own default; it has no dimensions, so parking fit cannot be checked and an
 * unknown slot is accepted rather than rejected against invented numbers.
 */
export function enableLearnedTypes(dir = learnedDir()): { types: number; packs: number } {
  const learned = learnedTypes(dir);
  registerTypeSource({
    find(type) {
      const hit = learned.get(type);
      if (!hit) return undefined;
      if (hit.category === "plane" || hit.category === "helicopter") {
        return {
          category: hit.category,
          entry: {
            type: hit.type,
            fuelMax: null,
            width: null,
            length: null,
            height: null,
            chaff: null,
            flare: null,
            tasks: [],
            defaultTask: null,
          } satisfies FlyingType,
        };
      }
      if (hit.category === "static") {
        return {
          category: "static",
          entry: {
            type: hit.type,
            name: hit.type,
            group: "Learned",
            shape: hit.shapeName ?? null,
            // The `category` field DCS writes is the one thing a mission states
            // outright for a static, so it is used as-is; without it a static
            // cannot be written at all, and 'Fortifications' is what the
            // overwhelming majority of unlisted ones carry.
            category: hit.staticCategory ?? "Fortifications",
            rate: hit.rate ?? 0,
            canCargo: false,
          } satisfies StaticType,
        };
      }
      return { category: hit.category, entry: { type: hit.type, name: hit.type, group: "Learned" } satisfies NamedType };
    },
    list() {
      return [...learned.values()].map((t) => ({ type: t.type, category: t.category }));
    },
  });
  return { types: learned.size, packs: loadLearnedPacks(dir).length };
}
