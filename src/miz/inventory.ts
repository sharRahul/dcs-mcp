/**
 * What a country really operates, set against what DCS can place for it.
 *
 * Three sources, kept distinct because they mean different things:
 *   - real world: Wikipedia equipment lists (data/real-world-inventory.json),
 *   - DCS offers:  the Mission Editor's per-country list (data/countries.json),
 *   - mods:        unit mods installed on this machine (src/dcs/mods.ts).
 * A real-world type with no DCS match may still be flyable through a mod; the
 * match is by designation family and is labelled heuristic.
 */
import { findCountry, realWorldInventory, type RealWorldEntry } from "../data/reference.js";
import { installedMods, type InstalledMod } from "../dcs/mods.js";

const DESIG = /\b([A-Za-z]{1,5})[- ]?(\d{1,4})/g;

/** Designation families: "Sukhoi Su-30MKI" -> {"su30"}, "F/A-18E" -> {"fa18"}. */
export function designationFamilies(text: string): Set<string> {
  const t = text.replace(/F\/A-?/g, "FA-");
  const out = new Set<string>();
  for (const m of t.matchAll(DESIG)) out.add(`${m[1].toLowerCase()}${m[2]}`);
  return out;
}

export type Availability = "dcs-for-country" | "dcs-other-country" | "mod" | "missing";

export interface InventoryRow extends RealWorldEntry {
  availability: Availability;
  /** Installed mod units sharing a designation family (only when DCS has none). */
  mods: { type: string; mod: string }[];
}

export interface CountryInventory {
  country: string;
  generated: string;
  pages: Partial<Record<"aircraft" | "ground" | "naval", string>>;
  aircraft: InventoryRow[];
  ground: InventoryRow[];
  naval: InventoryRow[];
  offeredCounts: { plane: number; helicopter: number; ship: number; vehicle: number };
}

function annotate(rows: RealWorldEntry[], mods: InstalledMod[]): InventoryRow[] {
  return rows.map((row) => {
    let availability: Availability = row.dcsForCountry.length
      ? "dcs-for-country"
      : row.dcs.length
        ? "dcs-other-country"
        : "missing";
    const found: { type: string; mod: string }[] = [];
    if (!row.dcs.length) {
      const families = designationFamilies(`${row.name} ${row.wiki}`);
      for (const mod of mods) {
        for (const u of mod.units) {
          if ([...designationFamilies(u.type)].some((f) => families.has(f))) found.push({ type: u.type, mod: mod.id });
        }
      }
      if (found.length) availability = "mod";
    }
    return { ...row, availability, mods: found };
  });
}

export function countryInventory(name: string, mods = installedMods()): CountryInventory {
  const country = findCountry(name);
  if (!country) throw new Error(`Unknown country '${name}' (see dcs_list_countries).`);
  const inv = realWorldInventory();
  const rw = inv.countries[country.name];
  if (!rw) {
    throw new Error(
      `No real-world inventory for ${country.name} yet. Covered: ${Object.keys(inv.countries).join(", ")}. ` +
        `dcs_list_unit_types with country=${country.name} still lists what DCS offers it.`
    );
  }
  return {
    country: country.name,
    generated: inv.generated,
    pages: rw.pages,
    aircraft: annotate(rw.aircraft, mods),
    ground: annotate(rw.ground, mods),
    naval: annotate(rw.naval, mods),
    offeredCounts: {
      plane: country.units.plane.length,
      helicopter: country.units.helicopter.length,
      ship: country.units.ship.length,
      vehicle: country.units.vehicle.length,
    },
  };
}
