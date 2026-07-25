/** Canonical, data-only representation of a DCS mission. */

export type Coalition = "red" | "blue" | "neutrals";

export type GroupCategory = "plane" | "helicopter" | "ship" | "vehicle" | "static";

export interface LatLon {
  /** DCS internal metres east on the map grid (x in DCS is north). */
  x: number;
  /** DCS internal metres north/east on the map grid (y in DCS is east). */
  y: number;
}

export interface MissionUnit {
  name: string;
  /** DCS `unitId`. Triggers reference units by this, never by name. */
  id?: number;
  type: string;
  skill?: string;
  x: number;
  y: number;
  altitudeMetres?: number;
  heading?: number;
}

export interface MissionGroup {
  name: string;
  /** DCS `groupId`. Triggers reference groups by this, never by name. */
  id?: number;
  category: GroupCategory;
  coalition: Coalition;
  country: string;
  task?: string;
  units: MissionUnit[];
  waypointCount: number;
}

export interface TriggerZone {
  name: string;
  /** DCS `zoneId`. Triggers reference zones by this, never by name. */
  id?: number;
  x: number;
  y: number;
  radius?: number;
  type: "circle" | "polygon";
}

export interface MissionWeather {
  temperatureCelsius?: number;
  qnhMmHg?: number;
  cloudsBase?: number;
  windGroundSpeed?: number;
  windGroundDir?: number;
  turbulence?: number;
}

export interface MissionSummary {
  theatre: string;
  start_time?: number;
  date?: { Year: number; Month: number; Day: number };
  coalitions: Coalition[];
  countriesByCoalition: Record<string, string[]>;
  groupCount: number;
  unitCount: number;
  zoneCount: number;
  triggerCount: number;
  weather: MissionWeather;
  briefingTitle?: string;
}

export interface MissionTrigger {
  /** 1-based index into `mission.trigrules`. */
  index: number;
  /** Raw DCS predicate, e.g. 'triggerOnce', 'triggerStart', 'triggerContinious'. */
  predicate: string;
  comment?: string;
  /** Group names or ids referenced by this trigger's conditions and actions. */
  groupRefs: (string | number)[];
  /** Trigger-zone names or ids referenced by this trigger's conditions and actions. */
  zoneRefs: (string | number)[];
  /** Unit names or ids referenced by this trigger's conditions. */
  unitRefs: (string | number)[];
  /** Flag ids or names referenced by this trigger's conditions and actions. */
  flagRefs: (string | number)[];
  /** True when the compiled runtime entry (`mission.trig`) exists for this index. */
  compiled: boolean;
}

export interface MissionDocument {
  theatre: string;
  summary: MissionSummary;
  groups: MissionGroup[];
  zones: TriggerZone[];
  triggers: MissionTrigger[];
  weather: MissionWeather;
  /** Localized briefing text resolved through the dictionary, when present. */
  briefing: { title?: string; description?: string };
  /** SHA-256 of the source .miz archive bytes. */
  sourceDigest: string;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  location?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
