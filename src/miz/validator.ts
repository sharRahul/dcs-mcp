/** Structural and semantic validation of a parsed MissionDocument. */
import { validateAuthoring } from "./advanced-validation.js";
import type { LuaTable } from "./lua.js";
import type { MissionDocument, ValidationIssue, ValidationReport } from "../types.js";
import { countryOffers, findUnitType } from "../data/reference.js";
import { findModUnit } from "../dcs/mods.js";
import { EFFECT_STATICS } from "./editing.js";

/** Run read-only validation over a parsed mission. Never modifies the document. */
export function validateMission(doc: MissionDocument, mission?: LuaTable): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (mission) for (const issue of validateAuthoring(mission)) {
    (issue.severity === "error" ? errors : warnings).push(issue);
  }

  if (doc.theatre === "unknown") {
    warnings.push({ severity: "warning", code: "THEATRE_MISSING", message: "Mission has no theatre set" });
  }

  // Unique group and unit names.
  const groupNames = new Set<string>();
  const unitNames = new Set<string>();
  for (const group of doc.groups) {
    if (groupNames.has(group.name)) {
      errors.push({
        severity: "error",
        code: "DUP_GROUP_NAME",
        message: `Duplicate group name '${group.name}'`,
        location: `group:${group.name}`,
      });
    }
    groupNames.add(group.name);

    if (group.units.length === 0) {
      warnings.push({
        severity: "warning",
        code: "EMPTY_GROUP",
        message: `Group '${group.name}' has no units`,
        location: `group:${group.name}`,
      });
    }

    // The Mission Editor's `fixUnitsPos` indexes `route.points[1]` for every
    // group that has a route, so an empty one makes the editor fail to open the
    // WHOLE mission ("attempt to index field '?' (a nil value)"). This is an
    // error, not a warning: the mission is unopenable.
    if (group.waypointCount === 0) {
      errors.push({
        severity: "error",
        code: "GROUP_NO_ROUTE_POINTS",
        message:
          `Group '${group.name}' has no route points. The DCS Mission Editor cannot open a mission ` +
          `containing such a group; give it at least one waypoint at its spawn position.`,
        location: `group:${group.name}`,
      });
    }

    for (const unit of group.units) {
      if (unitNames.has(unit.name)) {
        // The editor itself saves duplicate unit names (65 of them across the 193
        // ME-saved missions this was calibrated against), so DCS accepts them. They
        // still break every lookup that goes by name, here and in mission scripts.
        warnings.push({
          severity: "warning",
          code: "DUP_UNIT_NAME",
          message:
            `Duplicate unit name '${unit.name}'. DCS accepts it (the Mission Editor saves duplicates), ` +
            `but every name-based lookup — this server's tools and Unit.getByName in scripts — can only find one of them.`,
          location: `unit:${unit.name}`,
        });
      }
      unitNames.add(unit.name);

      if (unit.type === "unknown") {
        warnings.push({
          severity: "warning",
          code: "UNIT_TYPE_MISSING",
          message: `Unit '${unit.name}' has no type`,
          location: `unit:${unit.name}`,
        });
      }
    }
  }

  // Unique zone names.
  const zoneNames = new Set<string>();
  for (const zone of doc.zones) {
    if (zoneNames.has(zone.name)) {
      errors.push({
        severity: "error",
        code: "DUP_ZONE_NAME",
        message: `Duplicate trigger-zone name '${zone.name}'`,
        location: `zone:${zone.name}`,
      });
    }
    zoneNames.add(zone.name);

    if (zone.type === "circle" && (zone.radius === undefined || zone.radius <= 0)) {
      warnings.push({
        severity: "warning",
        code: "ZONE_RADIUS",
        message: `Circular zone '${zone.name}' has no positive radius`,
        location: `zone:${zone.name}`,
      });
    }
  }

  // Trigger cross-references. A trigger pointing at a group, unit or zone that is
  // not in the mission does nothing at all in DCS, and does so silently. Triggers
  // reference by numeric DCS id; names only appear in older, hand-edited missions,
  // so both forms are resolvable here.
  const groupRefs = new Set<string | number>();
  for (const group of doc.groups) {
    groupRefs.add(group.name);
    if (group.id !== undefined) groupRefs.add(group.id);
  }
  const unitRefs = new Set<string | number>();
  for (const group of doc.groups) {
    for (const unit of group.units) {
      unitRefs.add(unit.name);
      if (unit.id !== undefined) unitRefs.add(unit.id);
    }
  }
  const zoneRefs = new Set<string | number>();
  for (const zone of doc.zones) {
    zoneRefs.add(zone.name);
    if (zone.id !== undefined) zoneRefs.add(zone.id);
  }

  const missingRef = (
    label: string,
    index: number,
    refs: (string | number)[],
    known: Set<string | number>,
    code: string,
    kind: string
  ) => {
    for (const ref of refs) {
      if (known.has(ref)) continue;
      // A dangling reference is a trigger that can never fire, not a mission that fails
      // to load: ME-saved missions contain them (a group deleted after the trigger was
      // written), and DCS opens and runs those files.
      warnings.push({
        severity: "warning",
        code,
        message:
          `${label} references ${kind} '${ref}', which does not exist in this mission. ` +
          `DCS still loads the mission; that condition or action simply never matches.`,
        location: `trigger:${index}`,
      });
    }
  };

  for (const trigger of doc.triggers) {
    const label = trigger.comment ? `trigger #${trigger.index} ('${trigger.comment}')` : `trigger #${trigger.index}`;
    missingRef(label, trigger.index, trigger.groupRefs, groupRefs, "TRIGGER_GROUP_MISSING", "group");
    missingRef(label, trigger.index, trigger.zoneRefs, zoneRefs, "TRIGGER_ZONE_MISSING", "trigger zone");
    missingRef(label, trigger.index, trigger.unitRefs, unitRefs, "TRIGGER_UNIT_MISSING", "unit");

    for (const flag of trigger.flagRefs) {
      // DCS accepts an integer flag id or a named flag; anything else (a float,
      // an empty name) is an editing mistake that never matches at runtime.
      const valid = typeof flag === "number" ? Number.isInteger(flag) : flag.length > 0;
      if (!valid) {
        errors.push({
          severity: "error",
          code: "TRIGGER_FLAG_INVALID",
          message: `${label} uses flag '${flag}', which is neither an integer flag id nor a flag name`,
          location: `trigger:${trigger.index}`,
        });
      }
    }

    if (!trigger.compiled) {
      warnings.push({
        severity: "warning",
        code: "TRIGGER_NOT_COMPILED",
        message:
          `${label} has no compiled runtime entry (mission.trig), so it will not fire unless the ` +
          `mission is opened and saved in the DCS Mission Editor`,
        location: `trigger:${trigger.index}`,
      });
    }
  }

  // QNH sanity check (mmHg).
  const qnh = doc.weather.qnhMmHg;
  if (qnh !== undefined && (qnh < 650 || qnh > 850)) {
    warnings.push({
      severity: "warning",
      code: "QNH_RANGE",
      message: `QNH ${qnh} mmHg is outside the plausible range 650-850`,
    });
  }

  // Unit types the catalogue does not know. A warning, not an error: new modules
  // and mods add types the bundled list predates. A typo, though, spawns nothing.
  const unknownTypes = new Map<string, string>();
  // A type a mod declares but that is NOT deployed is a different problem from a
  // typo: the id is real, and DCS will simply fail to spawn it until the mod is
  // enabled. Reported separately, because "probably a typo" would be wrong and
  // "known" would hide a mission that does not load.
  const undeployed = new Map<string, { unit: string; mod: string; repository?: string }>();
  // Learned from someone's mission, but no mod on this machine declares it: the id
  // is real for whoever built that mission and will not spawn here.
  const learnedOnly = new Map<string, string>();
  for (const group of doc.groups) {
    for (const unit of group.units) {
      if (!unit.type) continue;
      // EFFECT_STATICS are real DCS types that the pinned pydcs does not list, so
      // they are named in editing.ts from ED's own db_countries.lua rather than
      // reported as typos.
      if (EFFECT_STATICS.has(unit.type)) continue;
      const known = findUnitType(unit.type);
      // Only the BUNDLED catalogue ends the question. A type that resolves because
      // it was learned from a mission is evidence the id is real, not evidence it
      // will spawn HERE - so the mod check still runs, or a learned id would
      // silently hide an undeployed mod.
      // An install (CoreMods) definition is on THIS machine, so it spawns here too.
      if (known?.source === "bundled" || known?.source === "install") continue;
      const mod = findModUnit(unit.type);
      if (mod?.deployed) continue;
      if (mod) {
        if (!undeployed.has(unit.type)) {
          undeployed.set(unit.type, { unit: unit.name, mod: mod.mod, repository: mod.repository });
        }
        continue;
      }
      if (known) {
        // Learned from a mission, and nothing on this machine declares it.
        if (!learnedOnly.has(unit.type)) learnedOnly.set(unit.type, unit.name);
        continue;
      }
      if (!unknownTypes.has(unit.type)) unknownTypes.set(unit.type, unit.name);
    }
  }
  for (const [type, unit] of learnedOnly) {
    warnings.push({
      severity: "warning",
      code: "TYPE_NOT_ON_THIS_MACHINE",
      message:
        `Unit type '${type}' (first used by '${unit}') is known only from missions that use it - no bundled ` +
        `catalogue entry and no mod on this machine declares it. The id is real for whoever built those ` +
        `missions; here the unit will not spawn. Install the mod, or pick a type dcs_list_unit_types offers.`,
      location: `unit:${unit}`,
    });
  }
  for (const [type, hit] of undeployed) {
    warnings.push({
      severity: "warning",
      code: "MOD_NOT_DEPLOYED",
      message:
        `Unit type '${type}' (first used by '${hit.unit}') is declared by the mod '${hit.mod}', which is in a mod ` +
        `repository${hit.repository ? ` (${hit.repository})` : ""} rather than a Mods folder DCS loads. The id is ` +
        `real, but DCS will not spawn it until that mod is enabled - the mission will load with the unit missing.`,
      location: `unit:${hit.unit}`,
    });
  }
  for (const [type, unit] of unknownTypes) {
    warnings.push({
      severity: "warning",
      code: "UNKNOWN_UNIT_TYPE",
      message:
        `Unit type '${type}' (first used by '${unit}') is not in the bundled DCS catalogue or any mod installed ` +
        `on this machine. If it is not a very new module, it is a typo and the unit will not spawn; see ` +
        `dcs_list_unit_types and dcs_list_installed_mods.`,
      location: `unit:${unit}`,
    });
  }

  // Types the Mission Editor does not list for the unit's country. DCS's lists
  // are permissive, so this flags real mismatches (an SA-10 for the USA), not
  // realism; what happens to such a unit in the editor or sim is untested here.
  const offMenu = new Map<string, string>();
  for (const group of doc.groups) {
    if (group.category === "static") continue;
    for (const unit of group.units) {
      // pydcs lists what the editor offers for the types pydcs knows. It cannot
      // know a mod type or one learned from a mission, and would report every
      // one of them as not offered to any country - which says nothing.
      if (findUnitType(unit.type)?.source !== "bundled") continue;
      const key = `${group.country}|${unit.type}`;
      if (!offMenu.has(key) && countryOffers(group.country, unit.type) === false) offMenu.set(key, unit.name);
    }
  }
  for (const [key, unit] of offMenu) {
    const [country, type] = key.split("|");
    warnings.push({
      severity: "warning",
      code: "COUNTRY_TYPE_NOT_OFFERED",
      message:
        `The Mission Editor does not offer '${type}' to ${country} (first: '${unit}'). Use a country that ` +
        `operates it, or a Combined Joint Task Forces country; see dcs_country_inventory.`,
      location: `unit:${unit}`,
    });
  }

  // Only one unit can be the single-player aircraft; multiplayer slots are 'Client'.
  const players = doc.groups.flatMap((g) => g.units.filter((u) => u.skill === "Player"));
  if (players.length > 1) {
    warnings.push({
      severity: "warning",
      code: "MULTIPLE_PLAYER_UNITS",
      message:
        `${players.length} units have skill 'Player' (${players.map((u) => u.name).slice(0, 6).join(", ")}). ` +
        `A mission has one Player aircraft; make the others 'Client' slots.`,
    });
  }

  // A country belongs to exactly one coalition.
  const sideOf = new Map<string, string>();
  for (const [side, names] of Object.entries(doc.summary.countriesByCoalition ?? {})) {
    for (const name of names) {
      const previous = sideOf.get(name);
      if (previous && previous !== side) {
        errors.push({
          severity: "error",
          code: "COUNTRY_ON_TWO_SIDES",
          message: `Country '${name}' appears in both the ${previous} and ${side} coalitions.`,
          location: `country:${name}`,
        });
      }
      sideOf.set(name, side);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
