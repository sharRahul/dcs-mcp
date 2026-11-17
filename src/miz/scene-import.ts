/**
 * Import a static COMPOUND footprint - a barracks block, an ammo dump, a walled
 * outpost, a vehicle park - from a mission the user supplies.
 *
 * The built-in target templates in `dressing.ts` lay their objects out on a
 * rotated grid, which is this project's own convention: the right objects in the
 * wrong shape. A real compound in an editor-saved mission is not a grid. It has
 * a perimeter (HESCO sections, sandbags, revetments), objects at their own
 * individual headings, and spacing someone chose by eye. None of that is
 * derivable, so it is measured from the file instead:
 *
 *   - statics are grouped by proximity (single-linkage at `linkMetres`), which is
 *     what makes a compound one thing rather than a list of statics;
 *   - the frame is the cluster's MODAL heading, because editor-placed compounds
 *     share a facing even when individual props are turned;
 *   - every object keeps its exact offset along/right of that frame AND its own
 *     heading offset, so placing the template at another position and heading
 *     reproduces the layout rather than approximating it.
 *
 * Provenance is `imported`, the same weak tier `site-import.ts` uses and for the
 * same reasons: this project has not opened the result in the Mission Editor, and
 * cannot prove the source file was editor-saved. Nothing here ships as a
 * built-in - a footprint belongs to whoever built the mission it came from, so
 * imported templates stay in the user's own template folder.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readMizArchive } from "./archive.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "./lua.js";
import { templateDir } from "./site-import.js";
import { findUnitType } from "../data/reference.js";

/** Scene templates live beside the site templates, under their own prefix. */
const PREFIX = "scene-";
const FORMAT = "dcs-mcp-scene-template/1";

export interface SceneObject {
  type: string;
  /** Metres along the template heading. */
  forward: number;
  /** Metres right of the template heading. */
  right: number;
  /** Degrees this object is turned relative to the template heading. */
  headingOffset: number;
  /** The source placed it as a wreck. */
  dead?: boolean;
  /** Only when the source carried one, since the catalogue shape is the default. */
  shapeName?: string;
}

export interface SceneTemplate {
  format: typeof FORMAT;
  id: string;
  description: string;
  provenance: "imported";
  /** Objects in source order. */
  objects: SceneObject[];
  /** Distance from the centre to the furthest object. */
  radiusMetres: number;
  /** Count per type, for listing a template without expanding it. */
  typeCounts: Record<string, number>;
  source: {
    file: string;
    sha256: string;
    theatre: string;
    side: string;
    country: string;
    groups: string[];
    /** The cluster's own heading in the source, for reference only. */
    headingDegrees: number;
    importedAt: string;
  };
  notes: string[];
}

const safeId = (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/.test(id)) throw new Error("Template id: 1-48 letters, digits, space, _ . -");
  return id;
};
const fileFor = (dir: string, id: string) => path.join(dir, `${PREFIX}${safeId(id).replace(/[ .]/g, "_")}.json`);

/** Imported scene templates on disk; an unreadable file is skipped, never fatal. */
export function loadSceneTemplates(dir = templateDir()): SceneTemplate[] {
  let files: string[] = [];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(PREFIX) && f.endsWith(".json")) : [];
  } catch {
    return [];
  }
  const out: SceneTemplate[] = [];
  for (const f of files) {
    try {
      const t = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as SceneTemplate;
      if (t.format === FORMAT && Array.isArray(t.objects) && t.objects.length) out.push(t);
    } catch {
      /* skipped */
    }
  }
  return out;
}

export function findSceneTemplate(id: string, dir = templateDir()): SceneTemplate {
  const hit = loadSceneTemplates(dir).find((t) => t.id.toLowerCase() === id.toLowerCase());
  if (!hit) {
    const have = loadSceneTemplates(dir).map((t) => t.id);
    throw new Error(
      `No imported scene template '${id}'. ${have.length ? `Available: ${have.join(", ")}.` : "Import one with dcs_import_scene_template."}`
    );
  }
  return hit;
}

export function removeSceneTemplate(id: string, dir = templateDir()): { removed: string } {
  const file = fileFor(dir, id);
  if (!existsSync(file)) throw new Error(`No imported scene template '${id}'`);
  rmSync(file);
  return { removed: id };
}

// --- clustering ------------------------------------------------------------

interface SourceObject {
  type: string;
  x: number;
  y: number;
  headingRadians: number;
  name: string;
  group: string;
  dead: boolean;
  shapeName?: string;
}

export interface SceneCandidate {
  index: number;
  count: number;
  typeCounts: Record<string, number>;
  radiusMetres: number;
  /** Modal heading of the cluster, in degrees. */
  headingDegrees: number;
  /** How many distinct object headings it contains: 1 means a grid-like block. */
  distinctHeadings: number;
  side: string;
  country: string;
  groups: string[];
  /** Centre in the source mission, so a caller can tell two clusters apart. */
  centre: { x: number; y: number };
  objects: SceneObject[];
}

export interface ScanSceneArgs {
  file: string;
  /** Nearest-neighbour link distance in metres. Default 60. */
  linkMetres?: number;
  /** Smallest cluster to report. Default 4. */
  minObjects?: number;
  /** Largest cluster to report; bigger ones are usually whole airfields. Default 80. */
  maxObjects?: number;
  side?: "red" | "blue" | "neutrals";
}

const DEG = 180 / Math.PI;

/**
 * Find the static clusters in a mission. Returns candidates ordered by size; the
 * caller picks one by `index` and imports it. Nothing is written.
 */
export async function scanSceneCandidates(args: ScanSceneArgs): Promise<{
  file: string;
  sha256: string;
  theatre: string;
  statics: number;
  candidates: SceneCandidate[];
  notes: string[];
}> {
  const link = args.linkMetres ?? 60;
  const min = args.minObjects ?? 4;
  const max = args.maxObjects ?? 80;
  if (link <= 0 || link > 2000) throw new Error("linkMetres must be between 1 and 2000");
  if (min < 2) throw new Error("minObjects must be at least 2");
  if (max < min) throw new Error("maxObjects must be at least minObjects");

  const archive = await readMizArchive(args.file);
  const text = archive.entries.get("mission");
  if (!text) throw new Error("No mission entry in that .miz");
  const mission = parseLuaAssignment(text, "mission");
  const theatre = String(mission["theatre"] ?? "");
  const candidates: SceneCandidate[] = [];
  let statics = 0;

  for (const side of ["blue", "red", "neutrals"] as const) {
    if (args.side && args.side !== side) continue;
    for (const country of luaArray(asTable(asTable(mission["coalition"])?.[side])?.["country"])) {
      const objects: SourceObject[] = [];
      for (const group of luaArray(asTable(country["static"])?.["group"])) {
        for (const unit of luaArray(asTable(group["units"]))) {
          const x = Number(unit["x"]);
          const y = Number(unit["y"]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          objects.push({
            type: String(unit["type"]),
            x,
            y,
            headingRadians: Number(unit["heading"] ?? 0),
            name: String(unit["name"] ?? ""),
            group: String(group["name"] ?? ""),
            dead: group["dead"] === true,
            ...(typeof unit["shape_name"] === "string" ? { shapeName: unit["shape_name"] } : {}),
          });
        }
      }
      statics += objects.length;
      for (const members of cluster(objects, link)) {
        if (members.length < min || members.length > max) continue;
        candidates.push(
          describeCluster(members, side, String(country["name"] ?? ""), candidates.length + 1)
        );
      }
    }
  }
  candidates.sort((a, b) => b.count - a.count);
  candidates.forEach((c, i) => {
    c.index = i + 1;
  });
  return {
    file: path.basename(args.file),
    sha256: archive.digest,
    theatre,
    statics,
    candidates,
    notes: [
      `Clustered at ${link} m single linkage: two statics are in the same compound when one is within ${link} m of another already in it.`,
      "distinctHeadings tells you whether the source turned its objects individually; 1 means a block that was placed on a grid.",
      "A cluster is not a purpose. The type mix is what the file says; nothing here reads intent from it.",
      "Vehicles and aircraft placed AS STATICS are included, because the editor stores them in the same list.",
    ],
  };
}

/** Single-linkage clustering by distance, union-find over the object list. */
function cluster(objects: SourceObject[], link: number): SourceObject[][] {
  const parent = objects.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      if (Math.hypot(objects[i].x - objects[j].x, objects[i].y - objects[j].y) <= link) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, SourceObject[]>();
  objects.forEach((o, i) => {
    const root = find(i);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(o);
  });
  return [...byRoot.values()];
}

function describeCluster(members: SourceObject[], side: string, country: string, index: number): SceneCandidate {
  const cx = members.reduce((a, o) => a + o.x, 0) / members.length;
  const cy = members.reduce((a, o) => a + o.y, 0) / members.length;
  // Modal heading: editor-placed compounds share a facing, with props turned off it.
  const counts = new Map<number, number>();
  for (const o of members) {
    const k = Math.round(o.headingRadians * DEG);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const modal = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const h = modal / DEG;
  const cos = Math.cos(h);
  const sin = Math.sin(h);
  const round = (n: number) => Math.round(n * 10) / 10;
  let radius = 0;
  const objects: SceneObject[] = members.map((o) => {
    // x is NORTH and y is EAST, so the frame's forward vector is (cos h, sin h).
    const dx = o.x - cx;
    const dy = o.y - cy;
    const forward = dx * cos + dy * sin;
    const right = -dx * sin + dy * cos;
    radius = Math.max(radius, Math.hypot(forward, right));
    return {
      type: o.type,
      forward: round(forward),
      right: round(right),
      headingOffset: Math.round((((o.headingRadians * DEG - modal) % 360) + 360) % 360),
      ...(o.dead ? { dead: true } : {}),
      ...(o.shapeName ? { shapeName: o.shapeName } : {}),
    };
  });
  const typeCounts: Record<string, number> = {};
  for (const o of members) typeCounts[o.type] = (typeCounts[o.type] ?? 0) + 1;
  return {
    index,
    count: members.length,
    typeCounts,
    radiusMetres: Math.ceil(radius),
    headingDegrees: ((modal % 360) + 360) % 360,
    distinctHeadings: new Set(objects.map((o) => o.headingOffset)).size,
    side,
    country,
    groups: [...new Set(members.map((o) => o.group))],
    centre: { x: Math.round(cx), y: Math.round(cy) },
    objects,
  };
}

// --- importing -------------------------------------------------------------

export interface ImportSceneArgs extends ScanSceneArgs {
  /** Which candidate from a scan of the same file, 1-based. */
  candidate: number;
  id: string;
  description?: string;
  overwrite?: boolean;
}

export async function importSceneTemplate(
  args: ImportSceneArgs,
  dir = templateDir()
): Promise<{ template: SceneTemplate; path: string }> {
  safeId(args.id);
  const scan = await scanSceneCandidates(args);
  const chosen = scan.candidates.find((c) => c.index === args.candidate);
  if (!chosen) {
    throw new Error(
      `Candidate ${args.candidate} does not exist: that scan found ${scan.candidates.length}. ` +
        `Run dcs_scan_scene_candidates with the same file and settings first.`
    );
  }
  const unknown = [...new Set(chosen.objects.map((o) => o.type).filter((t) => !findUnitType(t)))];
  if (unknown.length) {
    throw new Error(
      `These types are not in the bundled catalogue, so a placed copy would be refused: ${unknown.join(", ")}. ` +
        `They may come from a mod (dcs_list_installed_mods) or a newer DCS than the pinned pydcs data.`
    );
  }
  const file = fileFor(dir, args.id);
  if (existsSync(file) && !args.overwrite) throw new Error(`Scene template '${args.id}' already exists; pass overwrite`);

  const template: SceneTemplate = {
    format: FORMAT,
    id: args.id,
    description:
      args.description ??
      `${chosen.count} statics, ${Object.entries(chosen.typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([t, n]) => `${t} x${n}`)
        .join(", ")}`,
    provenance: "imported",
    objects: chosen.objects,
    radiusMetres: chosen.radiusMetres,
    typeCounts: chosen.typeCounts,
    source: {
      file: scan.file,
      sha256: scan.sha256,
      theatre: scan.theatre,
      side: chosen.side,
      country: chosen.country,
      groups: chosen.groups,
      headingDegrees: chosen.headingDegrees,
      importedAt: new Date().toISOString(),
    },
    notes: [
      "Offsets and per-object heading offsets are measured from the source file, not generated.",
      "The frame is the cluster's modal heading; a placed copy rotates every offset and heading with it.",
      "Provenance 'imported': this project has neither flown nor opened this layout in the Mission Editor.",
      "The source mission is only read. Its author's layout stays in your own template folder and is never shipped.",
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(template, null, 1), "utf8");
  return { template, path: file };
}

/** Content hash of a template's geometry, so two imports can be compared. */
export function sceneFingerprint(template: SceneTemplate): string {
  return createHash("sha256")
    .update(JSON.stringify(template.objects.map((o) => [o.type, o.forward, o.right, o.headingOffset])))
    .digest("hex")
    .slice(0, 16);
}
