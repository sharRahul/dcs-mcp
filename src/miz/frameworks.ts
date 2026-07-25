/**
 * Mission scripting frameworks (MIST, MOOSE, Skynet-IADS) and user scripts.
 *
 * A framework is just a Lua file embedded in the `.miz` and loaded by a
 * `DO SCRIPT FILE` action on a MISSION START trigger. Two things make it fiddly,
 * and both are handled here:
 *
 *  1. **Order.** DCS walks `mission.trig.funcStartup` with `pairs`, so separate
 *     START triggers have NO defined order. Skynet fails to initialise if MIST
 *     has not loaded yet. Every load therefore goes into ONE start trigger, whose
 *     actions run top to bottom. This mirrors what the Mission Editor produces:
 *     the shipped Skynet and MOOSE demo missions each use a single "Load Scripts"
 *     start trigger with ordered `a_do_script_file` actions.
 *  2. **Dependencies.** Frameworks are sorted into load order regardless of the
 *     order they were requested in, and user setup scripts always come last.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { LuaTable } from "./lua.js";
import {
  addTrigger,
  appendTriggerActions,
  findTriggerByComment,
  type ActionSpec,
} from "./authoring.js";
import { addResource, type ResourceStore } from "./resources.js";

/** The single start trigger every script load is appended to. */
export const SCRIPT_TRIGGER_COMMENT = "Load Scripts";

export type FrameworkName = "mist" | "moose" | "skynet";

interface FrameworkInfo {
  /** Lower loads first. Skynet needs MIST already in memory. */
  order: number;
  label: string;
  /** Globs-ish file name patterns, most specific first. */
  patterns: RegExp[];
  requires: FrameworkName[];
  notes: string;
}

export const FRAMEWORKS: Record<FrameworkName, FrameworkInfo> = {
  mist: {
    order: 1,
    label: "MIST",
    // Only the versioned single-file release, e.g. `mist_4_5_126.lua`. A looser
    // pattern picks up MIST's own `mist_DBs_*.lua` example dumps, which are a few
    // KB of sample data and load nothing.
    patterns: [/^mist_\d+(?:_\d+)*\.lua$/i, /^mist\.lua$/i],
    requires: [],
    notes: "Mission Scripting Tools. Skynet depends on it; MOOSE does not.",
  },
  moose: {
    order: 2,
    label: "MOOSE",
    patterns: [/^moose\.lua$/i, /^moose_\d[\d._]*\.lua$/i],
    requires: [],
    notes: "Large single-file framework (~11 MB); embedding it grows the .miz.",
  },
  skynet: {
    order: 3,
    label: "Skynet-IADS",
    // The compiled single-file build; the repo also ships per-class sources and
    // per-mission `*-setup-*.lua` files that must not be mistaken for it.
    patterns: [/^skynet-iads-compiled\.lua$/i, /^skynet-iads\.lua$/i],
    requires: ["mist"],
    notes: "Integrated Air Defence System. Requires MIST to be loaded first.",
  },
};

/**
 * Smallest plausible size for each framework's single-file build. A match far
 * below this is almost certainly a sample or a stub, and silently embedding it
 * produces a mission where the framework simply is not there.
 */
const MIN_PLAUSIBLE_BYTES: Record<FrameworkName, number> = {
  mist: 100_000,
  moose: 1_000_000,
  skynet: 50_000,
};

/** Directories searched when no explicit path is given, most likely first. */
export function defaultSearchRoots(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const saved = path.join(home, "Saved Games", "DCS");
  const savedOpenBeta = path.join(home, "Saved Games", "DCS.openbeta");
  return [
    path.join(saved, "Missions", "LUA Scripts"),
    path.join(saved, "Scripts"),
    path.join(savedOpenBeta, "Missions", "LUA Scripts"),
    path.join(savedOpenBeta, "Scripts"),
  ];
}

/** Order frameworks by dependency, pulling in anything a request implies. */
export function resolveLoadOrder(requested: FrameworkName[]): FrameworkName[] {
  const wanted = new Set<FrameworkName>();
  const add = (name: FrameworkName) => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dep of FRAMEWORKS[name].requires) add(dep);
  };
  for (const name of requested) add(name);
  return [...wanted].sort((a, b) => FRAMEWORKS[a].order - FRAMEWORKS[b].order);
}

/**
 * Look for a framework's Lua file under the search roots.
 *
 * Bounded in depth and in how many directories it will walk: this runs against
 * a user's disk, and a runaway recursive scan of a deep tree is not worth the
 * convenience. Returns the newest-versioned match, so `mist_4_5_126.lua` wins
 * over `mist_4_5_107.lua`.
 */
export async function discoverFramework(
  name: FrameworkName,
  roots: string[] = defaultSearchRoots(),
  maxDepth = 3
): Promise<string | undefined> {
  const patterns = FRAMEWORKS[name].patterns;
  const matches: string[] = [];
  let dirsWalked = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || dirsWalked > 400) return;
    dirsWalked++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable roots are simply skipped
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (patterns.some((p) => p.test(entry.name))) {
        matches.push(full);
      }
    }
  };

  for (const root of roots) await walk(root, 0);
  if (matches.length === 0) return undefined;

  // Prefer the most specific pattern, then the highest version-ish name.
  matches.sort((a, b) => {
    const rank = (f: string) => patterns.findIndex((p) => p.test(path.basename(f)));
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return path.basename(b).localeCompare(path.basename(a), undefined, { numeric: true });
  });
  return matches[0];
}

/** Resolve a framework to a file: explicit path wins, otherwise auto-discover. */
export async function resolveFrameworkPath(
  name: FrameworkName,
  explicit?: string,
  roots: string[] = defaultSearchRoots()
): Promise<string> {
  if (explicit) {
    const info = await stat(explicit).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${FRAMEWORKS[name].label} script not found: ${explicit}`);
    return explicit; // an explicit path is the caller's call; no size guessing
  }
  const found = await discoverFramework(name, roots);
  if (!found) {
    throw new Error(
      `Could not find a ${FRAMEWORKS[name].label} script. Searched: ${roots.join(", ")}. ` +
        `Pass an explicit path instead.`
    );
  }
  const size = (await stat(found)).size;
  if (size < MIN_PLAUSIBLE_BYTES[name]) {
    throw new Error(
      `Auto-discovery found '${found}' for ${FRAMEWORKS[name].label}, but it is only ${size} bytes — ` +
        `too small to be the real framework (expected at least ${MIN_PLAUSIBLE_BYTES[name]}). ` +
        `Pass the correct path explicitly.`
    );
  }
  return found;
}

export interface LoadedScript {
  framework?: FrameworkName;
  fileName: string;
  sourcePath: string;
  resourceKey: string;
  bytes: number;
  reused: boolean;
}

/** Read a Lua file from disk, refusing anything that is not a .lua. */
export async function readLuaFile(filePath: string): Promise<{ fileName: string; content: Buffer }> {
  if (!filePath.toLowerCase().endsWith(".lua")) {
    throw new Error(`Mission scripts must be .lua files: ${filePath}`);
  }
  const content = await readFile(filePath);
  return { fileName: path.basename(filePath), content };
}

/**
 * Embed scripts and wire them into the mission's single start trigger.
 *
 * Returns what was embedded, in the order DCS will run it. Re-running with a
 * framework that is already loaded reuses its resource key and does not add a
 * second `DO SCRIPT FILE` action.
 */
export async function loadScripts(
  store: ResourceStore,
  dictionary: LuaTable,
  scripts: { framework?: FrameworkName; filePath: string }[]
): Promise<{ loaded: LoadedScript[]; triggerIndex: number }> {
  const loaded: LoadedScript[] = [];
  const actions: ActionSpec[] = [];

  for (const script of scripts) {
    const { fileName, content } = await readLuaFile(script.filePath);
    const resource = addResource(store, fileName, content);
    loaded.push({
      framework: script.framework,
      fileName,
      sourcePath: script.filePath,
      resourceKey: resource.key,
      bytes: resource.bytes,
      reused: resource.reused,
    });
    // A reused key means the file is already loaded by an existing action;
    // adding another would run the framework's initialisation twice.
    if (!resource.reused) actions.push({ kind: "do_script_file", resourceKey: resource.key });
  }

  let triggerIndex = findTriggerByComment(store.mission, SCRIPT_TRIGGER_COMMENT);
  if (triggerIndex === undefined) {
    triggerIndex = addTrigger(
      store.mission,
      { type: "start", comment: SCRIPT_TRIGGER_COMMENT, conditions: [], actions },
      dictionary
    );
  } else if (actions.length > 0) {
    appendTriggerActions(store.mission, triggerIndex, actions, dictionary);
  }

  return { loaded, triggerIndex };
}
