/**
 * SAM / air-defence site templates: the unit mix that makes a site work.
 *
 * A site is ONE group of mixed types — search radar, track radar, launchers,
 * sometimes a command post. Get the mix wrong and the site registers with
 * Skynet and never fires, which looks like broken AI rather than a bad group.
 *
 * Every template states where its composition comes from, because those are
 * different strengths of evidence:
 *   - "engaged":   built exactly this way and fought (and was destroyed) in a live
 *                  DCS sortie.
 *   - "me-saved":  copied from a Mission-Editor-saved mission, and also loaded in a
 *                  flown mission where Skynet registered it.
 *   - "loaded":    in a flown mission and registered with Skynet, but never engaged.
 *   - "catalogue": every type id exists in the DCS unit catalogue and the mix is
 *                  the system's standard battery, but this exact group has not
 *                  yet been flown or opened in the Mission Editor by this project.
 *   - "imported":  copied (types, order and exact per-unit offsets) from a mission the
 *                  user supplied via dcs_import_site_template; this project has not flown
 *                  it, and cannot prove the file was saved by the Mission Editor.
 *
 * Layout is the same column-along-heading the rest of the authoring API uses;
 * it is what the engaged SA-2 used and Skynet does not care about geometry.
 */
import type { UnitComposition } from "./authoring.js";
import { loadImportedTemplates } from "./site-import.js";

export type TemplateProvenance = "engaged" | "me-saved" | "loaded" | "catalogue" | "imported";

export interface SiteTemplate {
  id: string;
  description: string;
  provenance: TemplateProvenance;
  composition: UnitComposition[];
  spacingMetres: number;
  /** Skynet classifies sites by group-name prefix; this is the conventional one. */
  skynetRole: "sam" | "ewr";
  /** Imported templates only: exact per-unit offsets from the lead (metres along / right of its heading). */
  offsets?: { forward: number; right: number }[];
  /** Imported templates only: where the layout came from. */
  source?: { file: string; sha256: string; group: string; theatre: string; importedAt: string };
}

export const SITE_TEMPLATES: SiteTemplate[] = [
  {
    id: "SA-2",
    description: "S-75 Dvina: P-19 search radar, Fan Song track radar, 4 launchers.",
    provenance: "engaged",
    composition: [
      { type: "p-19 s-125 sr", count: 1 },
      { type: "SNR_75V", count: 1 },
      { type: "S_75M_Volhov", count: 4 },
    ],
    spacingMetres: 90,
    skynetRole: "sam",
  },
  {
    id: "SA-6",
    description: "2K12 Kub: Straight Flush search/track radar and 3 TELs.",
    provenance: "me-saved",
    composition: [
      { type: "Kub 1S91 str", count: 1 },
      { type: "Kub 2P25 ln", count: 3 },
    ],
    spacingMetres: 70,
    skynetRole: "sam",
  },
  {
    id: "SA-8",
    description: "9K33 Osa: self-contained TELARs (radar on each vehicle), pair.",
    provenance: "loaded",
    composition: [{ type: "Osa 9A33 ln", count: 2 }],
    spacingMetres: 50,
    skynetRole: "sam",
  },
  {
    id: "SA-3",
    description: "S-125 Neva: P-19 search radar, Low Blow track radar, 4 launchers.",
    provenance: "catalogue",
    composition: [
      { type: "p-19 s-125 sr", count: 1 },
      { type: "snr s-125 tr", count: 1 },
      { type: "5p73 s-125 ln", count: 4 },
    ],
    spacingMetres: 80,
    skynetRole: "sam",
  },
  {
    id: "SA-10",
    description: "S-300PS: Clam Shell + Big Bird search radars, Flap Lid track radar, command post, 4 TELs.",
    provenance: "catalogue",
    composition: [
      { type: "S-300PS 54K6 cp", count: 1 },
      { type: "S-300PS 40B6MD sr", count: 1 },
      { type: "S-300PS 64H6E sr", count: 1 },
      { type: "S-300PS 40B6M tr", count: 1 },
      { type: "S-300PS 5P85C ln", count: 2 },
      { type: "S-300PS 5P85D ln", count: 2 },
    ],
    spacingMetres: 120,
    skynetRole: "sam",
  },
  {
    id: "SA-11",
    description: "9K37 Buk: Snow Drift search radar, command post, 4 Fire Dome TELARs.",
    provenance: "catalogue",
    composition: [
      { type: "SA-11 Buk SR 9S18M1", count: 1 },
      { type: "SA-11 Buk CC 9S470M1", count: 1 },
      { type: "SA-11 Buk LN 9A310M1", count: 4 },
    ],
    spacingMetres: 100,
    skynetRole: "sam",
  },
  {
    id: "SA-15",
    description: "Tor M1: self-contained TELARs, pair.",
    provenance: "catalogue",
    composition: [{ type: "Tor 9A331", count: 2 }],
    spacingMetres: 60,
    skynetRole: "sam",
  },
  {
    id: "Hawk",
    description: "MIM-23 Hawk: search radar, CWAR, track radar, platoon command post, 3 launchers.",
    provenance: "catalogue",
    composition: [
      { type: "Hawk pcp", count: 1 },
      { type: "Hawk sr", count: 1 },
      { type: "Hawk cwar", count: 1 },
      { type: "Hawk tr", count: 1 },
      { type: "Hawk ln", count: 3 },
    ],
    spacingMetres: 80,
    skynetRole: "sam",
  },
  {
    id: "Patriot",
    description: "MIM-104 Patriot: radar, ECS, command post, power plant, relay, 4 launchers.",
    provenance: "catalogue",
    composition: [
      { type: "Patriot cp", count: 1 },
      { type: "Patriot str", count: 1 },
      { type: "Patriot ECS", count: 1 },
      { type: "Patriot EPP", count: 1 },
      { type: "Patriot AMG", count: 1 },
      { type: "Patriot ln", count: 4 },
    ],
    spacingMetres: 100,
    skynetRole: "sam",
  },
  {
    id: "NASAMS",
    description: "NASAMS: MPQ-64 radar, command post, 3 AIM-120C launchers.",
    provenance: "catalogue",
    composition: [
      { type: "NASAMS_Command_Post", count: 1 },
      { type: "NASAMS_Radar_MPQ64F1", count: 1 },
      { type: "NASAMS_LN_C", count: 3 },
    ],
    spacingMetres: 80,
    skynetRole: "sam",
  },
  {
    id: "EWR-55G6",
    description: "55G6 early-warning radar (Skynet matches EW radars by UNIT name prefix).",
    provenance: "loaded",
    composition: [{ type: "55G6 EWR", count: 1 }],
    spacingMetres: 20,
    skynetRole: "ewr",
  },
  {
    id: "EWR-1L13",
    description: "1L13 early-warning radar (Skynet matches EW radars by UNIT name prefix).",
    provenance: "loaded",
    composition: [{ type: "1L13 EWR", count: 1 }],
    spacingMetres: 20,
    skynetRole: "ewr",
  },
];

/** Built-in templates, then the user's imported ones (an import can never shadow a built-in id). */
export function allSiteTemplates(): SiteTemplate[] {
  const builtIn = new Set(SITE_TEMPLATES.map((t) => t.id.toLowerCase()));
  return [...SITE_TEMPLATES, ...loadImportedTemplates().filter((t) => !builtIn.has(t.id.toLowerCase()))];
}

export function findSiteTemplate(id: string): SiteTemplate {
  const key = id.toLowerCase().replace(/[\s_]/g, "-");
  const all = allSiteTemplates();
  const hit = all.find((t) => t.id.toLowerCase().replace(/[\s_]/g, "-") === key);
  if (!hit) {
    throw new Error(`Unknown site template '${id}'. Available: ${all.map((t) => t.id).join(", ")}.`);
  }
  return hit;
}
