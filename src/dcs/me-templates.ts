/**
 * The Mission Editor's own group-template library, read from the installed DCS.
 *
 * `MissionEditor/data/scripts/templates.lua` is a plain Lua assignment
 * (`templates = { ... }`) holding the batteries and sites the editor offers from
 * its template list: "SA-2 SAM Battery", "SA-6 SAM Battery", "Patriot site",
 * "Hawk SAM Battery" and so on. It is parsed as DATA and never executed.
 *
 * This is the best SA-2 layout available to this project, and it is first-party:
 * the shape is ED's, not a reconstruction. It beats anything assembled here from
 * a photograph or a reference diagram.
 *
 * Two things in the format matter and both differ from what this server writes
 * for a column of vehicles:
 *
 *   - offsets are `dx` / `dy` from the FIRST unit, with the template unstated-
 *     rotation (dx along the template's forward axis, dy to its right), so they
 *     map onto `SiteTemplate.offsets` directly;
 *   - EVERY unit carries its own `heading`. An SA-2's six launchers each point
 *     outward along their own bearing, and the two radar vans face a third way.
 *     A site is not a formation of identically-aligned vehicles.
 *
 * Nothing from here is vendored into the repository: the file belongs to the
 * install, so templates appear only on a machine that has DCS, and a template
 * read from it can never shadow a built-in id.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { parseLuaAssignment, asTable, type LuaTable } from "../miz/lua.js";
import { readText, installInfo } from "./install-info.js";
import type { SiteTemplate } from "../miz/templates.js";
import type { UnitComposition } from "../miz/authoring.js";

/** Path of the editor's template library inside an install. */
export function meTemplatesPath(root: string): string {
  return path.join(root, "MissionEditor", "data", "scripts", "templates.lua");
}

export interface MeTemplateUnit {
  type: string;
  /** Metres along the template's own forward axis, from the first unit. */
  forward: number;
  /** Metres to the right of it. */
  right: number;
  /** Degrees, absolute in the template's own frame. */
  headingDegrees: number;
  skill?: string;
}

export interface MeTemplate {
  name: string;
  /** "vehicle", "ship", … as the file states it; absent in many entries. */
  kind?: string;
  /** The DCS country id the template was saved under, when it carries one. */
  countryId?: number;
  units: MeTemplateUnit[];
  file: string;
  sha256: string;
}

const RAD = 180 / Math.PI;

/** Read and parse the editor template library. Returns [] when there is no install. */
export function meTemplates(root?: string): MeTemplate[] {
  const installRoot = root ?? installInfo().root;
  if (!installRoot) return [];
  const file = meTemplatesPath(installRoot);
  // The file is ~250 KB of tables; the default text cap is well above that.
  const source = readText(file);
  if (!source) return [];
  const sha256 = createHash("sha256").update(source).digest("hex");

  let parsed: LuaTable;
  try {
    parsed = parseLuaAssignment(source, "templates");
  } catch {
    return []; // a format change must not take the rest of the server down
  }

  const out: MeTemplate[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (name.startsWith("_")) continue;
    const entry = asTable(value as never);
    const units = asTable(entry?.units);
    if (!entry || !units) continue;

    // Unit keys are sparse and out of order in the file ([7] before [1]), and the
    // FIRST unit is the origin every dx/dy is measured from, so they are sorted
    // by key before anything else is read.
    const keys = Object.keys(units)
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const list: MeTemplateUnit[] = [];
    for (const key of keys) {
      const u = asTable(units[key]);
      // In this file a unit's `name` is its TYPE id, not a display name.
      const type = typeof u?.name === "string" ? u.name : undefined;
      if (!u || !type) continue;
      const forward = Number(u.dx ?? 0);
      const right = Number(u.dy ?? 0);
      const heading = Number(u.heading ?? 0);
      if (!Number.isFinite(forward) || !Number.isFinite(right) || !Number.isFinite(heading)) continue;
      list.push({
        type,
        forward,
        right,
        headingDegrees: ((heading * RAD) % 360 + 360) % 360,
        skill: typeof u.skill === "string" ? u.skill : undefined,
      });
    }
    if (!list.length) continue;

    out.push({
      name,
      kind: typeof entry.type === "string" ? entry.type : undefined,
      countryId: typeof entry.country === "number" ? entry.country : undefined,
      units: list,
      file,
      sha256,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Collapse consecutive runs of the same type into the composition shape. */
function composition(units: MeTemplateUnit[]): UnitComposition[] {
  const out: UnitComposition[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.type === u.type) last.count += 1;
    else out.push({ type: u.type, count: 1 });
  }
  return out;
}

/** A stable id for a template name: "SA-2 SAM Battery" -> "me-sa-2-sam-battery". */
export function meTemplateId(name: string): string {
  return `me-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * The editor's templates as site templates.
 *
 * Provenance is `me-saved`: this is the editor's own stored layout, which is
 * where that tier's meaning sits — copied from the Mission Editor rather than
 * reasoned about. It is NOT `engaged`: nothing here has been flown by this
 * project, and reading a file is not evidence that a site shoots back.
 */
export function meSiteTemplates(root?: string): SiteTemplate[] {
  return meTemplates(root).map((t) => {
    const first = t.units[0];
    const launchers = t.units.filter((u) => /ln$|launcher|Volhov|5P85/i.test(u.type)).length;
    // Classify the editor's explicit template label, not every AirDefence unit as SAM.
    const label = t.name.toLowerCase();
    const siteCategory: NonNullable<SiteTemplate['siteCategory']> = /searchlight/.test(label) ? 'searchlight' :
      /radar site/.test(label) ? 'radar' : /mortar/.test(label) ? 'artillery' :
      /bofors|flak|qf 3|aaa|\baa\b/.test(label) ? 'gun' :
      /sam|patriot/.test(label) ? 'sam' : 'other';
    return {
      id: meTemplateId(t.name),
      description:
        `Mission Editor template "${t.name}": ${t.units.length} unit(s)` +
        (launchers ? `, ${launchers} launcher(s)` : "") +
        `. Layout and per-unit headings exactly as the editor stores them.`,
      provenance: "me-saved" as const,
      composition: composition(t.units),
      // Offsets are relative to the first unit, which is the template's origin.
      offsets: t.units.map((u) => ({ forward: u.forward, right: u.right })),
      // Each unit's own facing, expressed relative to the first unit's, so the
      // whole site rotates as one when the group is given a heading.
      headingOffsetsDegrees: t.units.map(
        (u) => ((u.headingDegrees - first.headingDegrees) % 360 + 360) % 360
      ),
      spacingMetres: 50, // unused while offsets cover every unit
      siteCategory,
      skynetRole: siteCategory === 'sam' ? 'sam' : 'none',
      geometry: { kind: 'editor-authored', individualHeadings: true },
      execution: { status: 'unverified', skynetCompatibility: 'unknown' },
      historicalCompleteness: 'unknown',
      source: {
        file: t.file,
        sha256: t.sha256,
        group: t.name,
        theatre: "n/a (editor template library)",
        importedAt: "read from the install at call time; nothing is vendored",
      },
    };
  });
}
