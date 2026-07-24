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

  // Trigger cross-references. A trigger pointing at a group or zone that is not
  // in the mission does nothing at all in DCS, and does so silently.
  const groupIds = new Set<string | number>();
  for (const group of doc.groups) groupIds.add(group.name);
  for (const zone of doc.zones) zoneNames.add(zone.name);

  for (const trigger of doc.triggers) {
    const label = trigger.comment ? `trigger #${trigger.index} ('${trigger.comment}')` : `trigger #${trigger.index}`;
    for (const ref of trigger.groupRefs) {
      // Numeric refs are DCS groupIds, which the canonical model does not track;
      // only name-based references can be resolved here.
      if (typeof ref === "string" && !groupIds.has(ref)) {
        errors.push({
          severity: "error",
          code: "TRIGGER_GROUP_MISSING",
          message: `${label} references group '${ref}', which does not exist in this mission`,
          location: `trigger:${trigger.index}`,
        });
      }
    }
    for (const ref of trigger.zoneRefs) {
      if (typeof ref === "string" && !zoneNames.has(ref)) {
        errors.push({
          severity: "error",
          code: "TRIGGER_ZONE_MISSING",
          message: `${label} references trigger zone '${ref}', which does not exist in this mission`,
          location: `trigger:${trigger.index}`,
        });
      }
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
