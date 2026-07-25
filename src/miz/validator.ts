/** Structural and semantic validation of a parsed MissionDocument. */
import type { MissionDocument, ValidationIssue, ValidationReport } from "../types.js";

/** Run read-only validation over a parsed mission. Never modifies the document. */
export function validateMission(doc: MissionDocument): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

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
        errors.push({
          severity: "error",
          code: "DUP_UNIT_NAME",
          message: `Duplicate unit name '${unit.name}'`,
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
      errors.push({
        severity: "error",
        code,
        message: `${label} references ${kind} '${ref}', which does not exist in this mission`,
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

  return { ok: errors.length === 0, errors, warnings };
}
