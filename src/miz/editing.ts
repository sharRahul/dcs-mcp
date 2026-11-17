/**
 * Editing what is already in a mission: remove, rename, move and update groups,
 * units, waypoints and zones; add static objects; set mission-wide options.
 *
 * Like authoring.ts this works on the raw mission table so every field it does
 * not touch survives the round trip. Two rules run through all of it:
 *
 *  - Triggers reference groups, units and zones by numeric id. Removing one a
 *    trigger still points at produces a trigger that silently never fires, so
 *    removal is refused unless the caller passes `force` — and then the
 *    references are reported, not hidden.
 *  - Names are identities for scripts (Skynet prefixes, MOOSE lookups, inline
 *    `do_script` text). Renames refuse collisions and report the script
 *    resources that mention the old name, because we cannot rewrite those safely.
 */
import { asTable, luaArray, type LuaTable, type LuaValue } from "./lua.js";
import {
  countryId,
  ensureCountry,
  eachGroup,
  findGroup,
  findGroupOfUnit,
  maxIds,
  type Side,
} from "./authoring.js";
import { findCountry, findUnitType, unitTypes, type StaticType } from "../data/reference.js";
import { installedMods } from "../dcs/mods.js";
import type { MissionTrigger } from "../types.js";

function toList(items: LuaTable[]): LuaTable {
  const out: LuaTable = {};
  items.forEach((item, i) => {
    out[i + 1] = item;
  });
  return out;
}

function requireGroup(mission: LuaTable, name: string) {
  const found = findGroup(mission, name);
  if (!found) throw new Error(`No group named '${name}' in this mission`);
  return found;
}

function requireUnitGroup(mission: LuaTable, unitName: string) {
  const found = findGroupOfUnit(mission, unitName);
  if (!found) throw new Error(`No unit named '${unitName}' in this mission`);
  const unit = luaArray(found.group["units"]).find((u) => u["name"] === unitName) as LuaTable;
  return { ...found, unit };
}

function allNames(mission: LuaTable): { groups: Set<string>; units: Set<string> } {
  const groups = new Set<string>();
  const units = new Set<string>();
  eachGroup(mission, (group) => {
    groups.add(String(group["name"]));
    for (const u of luaArray(group["units"])) units.add(String(u["name"]));
  });
  return { groups, units };
}

/** Triggers that reference a group/unit/zone id. */
export function triggersReferencing(
  triggers: MissionTrigger[],
  kind: "group" | "unit" | "zone",
  id: number | undefined
): MissionTrigger[] {
  if (id === undefined) return [];
  const pick = (t: MissionTrigger) => (kind === "group" ? t.groupRefs : kind === "unit" ? t.unitRefs : t.zoneRefs);
  return triggers.filter((t) => pick(t).some((ref) => ref === id || ref === String(id)));
}

function refusal(what: string, refs: MissionTrigger[]): Error {
  const list = refs.map((t) => `#${t.index}${t.comment ? ` '${t.comment}'` : ""}`).join(", ");
  return new Error(
    `${what} is referenced by trigger(s) ${list}; removing it would leave them silently dead. ` +
      `Remove or change those triggers first, or pass force=true to remove it anyway.`
  );
}

export interface RemovalResult {
  removed: string;
  /** Trigger indices that still reference the removed id (only when forced). */
  danglingTriggers: number[];
}

// ---------------------------------------------------------------------------
// Groups and units
// ---------------------------------------------------------------------------

export function removeGroup(
  mission: LuaTable,
  triggers: MissionTrigger[],
  name: string,
  force = false
): RemovalResult {
  const found = requireGroup(mission, name);
  const gid = typeof found.group["groupId"] === "number" ? (found.group["groupId"] as number) : undefined;
  const refs = [...triggersReferencing(triggers, "group", gid)];
  for (const u of luaArray(found.group["units"])) {
    const uid = typeof u["unitId"] === "number" ? (u["unitId"] as number) : undefined;
    refs.push(...triggersReferencing(triggers, "unit", uid));
  }
  const unique = [...new Map(refs.map((t) => [t.index, t])).values()];
  if (unique.length && !force) throw refusal(`Group '${name}'`, unique);

  const catTable = asTable(found.country[found.category]) as LuaTable;
  const remaining = luaArray(catTable["group"]).filter((g) => g !== found.group);
  if (remaining.length) catTable["group"] = toList(remaining);
  else delete found.country[found.category];
  return { removed: name, danglingTriggers: unique.map((t) => t.index) };
}

export function removeUnit(
  mission: LuaTable,
  triggers: MissionTrigger[],
  unitName: string,
  force = false
): RemovalResult {
  const { group, unit } = requireUnitGroup(mission, unitName);
  const units = luaArray(group["units"]);
  if (units.length === 1) {
    throw new Error(
      `'${unitName}' is the only unit in group '${String(group["name"])}'; a group cannot be empty. ` +
        `Remove the group instead (dcs_miz_remove_group).`
    );
  }
  const uid = typeof unit["unitId"] === "number" ? (unit["unitId"] as number) : undefined;
  const refs = triggersReferencing(triggers, "unit", uid);
  if (refs.length && !force) throw refusal(`Unit '${unitName}'`, refs);
  group["units"] = toList(units.filter((u) => u !== unit));
  return { removed: unitName, danglingTriggers: refs.map((t) => t.index) };
}

export interface RenameResult {
  renamedUnits: { from: string; to: string }[];
}

/**
 * Rename a group. Units named `<old>-N` (the convention every authoring tool and
 * the editor use) follow the group unless `renameUnits` is false.
 */
export function renameGroup(mission: LuaTable, from: string, to: string, renameUnits = true): RenameResult {
  const found = requireGroup(mission, from);
  const names = allNames(mission);
  if (from !== to && names.groups.has(to)) throw new Error(`A group named '${to}' already exists`);
  const renamedUnits: { from: string; to: string }[] = [];
  if (renameUnits) {
    const prefix = `${from}-`;
    for (const unit of luaArray(found.group["units"])) {
      const name = String(unit["name"]);
      if (!name.startsWith(prefix)) continue;
      const next = `${to}-${name.slice(prefix.length)}`;
      if (names.units.has(next) && next !== name) throw new Error(`A unit named '${next}' already exists`);
      renamedUnits.push({ from: name, to: next });
    }
    for (const unit of luaArray(found.group["units"])) {
      const hit = renamedUnits.find((r) => r.from === unit["name"]);
      if (hit) unit["name"] = hit.to;
    }
  }
  found.group["name"] = to;
  return { renamedUnits };
}

export function renameUnit(mission: LuaTable, from: string, to: string): void {
  const { unit } = requireUnitGroup(mission, from);
  if (from !== to && allNames(mission).units.has(to)) throw new Error(`A unit named '${to}' already exists`);
  unit["name"] = to;
}

const DEG = Math.PI / 180;

function normalizeRadians(r: number): number {
  const twoPi = 2 * Math.PI;
  return ((r % twoPi) + twoPi) % twoPi;
}

export interface MoveGroupArgs {
  x: number;
  y: number;
  /** New heading in degrees; the formation is rotated about the lead to match. */
  heading?: number;
  /** Also translate waypoints 2..n (default: only the start point moves). */
  moveRoute?: boolean;
}

/**
 * Move a group so its lead unit sits at x/y, keeping the formation's shape.
 *
 * Every unit and the group's own x/y move by the same offset, as does route
 * point 1 (the spawn point). Later waypoints stay put unless `moveRoute` is set.
 * A new heading rotates each unit's offset from the lead and its own heading by
 * the same angle, so a column still trails its new direction of travel.
 */
export function moveGroup(mission: LuaTable, name: string, args: MoveGroupArgs): void {
  const { group } = requireGroup(mission, name);
  const units = luaArray(group["units"]);
  if (!units.length) throw new Error(`Group '${name}' has no units to move`);
  const lead = units[0];
  const leadX = Number(lead["x"]);
  const leadY = Number(lead["y"]);
  const dx = args.x - leadX;
  const dy = args.y - leadY;
  const oldHeading = Number(lead["heading"] ?? 0);
  const rotate = args.heading !== undefined ? normalizeRadians(args.heading * DEG) - oldHeading : 0;
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);

  for (const unit of units) {
    const ox = Number(unit["x"]) - leadX;
    const oy = Number(unit["y"]) - leadY;
    unit["x"] = args.x + ox * cos - oy * sin;
    unit["y"] = args.y + ox * sin + oy * cos;
    if (args.heading !== undefined) unit["heading"] = normalizeRadians(Number(unit["heading"] ?? 0) + rotate);
  }
  if (typeof group["x"] === "number") group["x"] = Number(group["x"]) + dx;
  if (typeof group["y"] === "number") group["y"] = Number(group["y"]) + dy;
  if (typeof group["heading"] === "number" && args.heading !== undefined) {
    group["heading"] = normalizeRadians(args.heading * DEG);
  }

  const points = luaArray(asTable(group["route"])?.["points"]);
  points.forEach((p, i) => {
    if (i > 0 && !args.moveRoute) return;
    if (i === 0) {
      // The spawn point follows the lead exactly.
      p["x"] = args.x;
      p["y"] = args.y;
    } else {
      p["x"] = Number(p["x"]) + dx;
      p["y"] = Number(p["y"]) + dy;
    }
  });
}

export function moveUnit(mission: LuaTable, unitName: string, x: number, y: number, heading?: number): void {
  const { group, unit } = requireUnitGroup(mission, unitName);
  unit["x"] = x;
  unit["y"] = y;
  if (heading !== undefined) unit["heading"] = normalizeRadians(heading * DEG);
  const units = luaArray(group["units"]);
  if (units[0] === unit) {
    const first = asTable(asTable(asTable(group["route"])?.["points"])?.[1]);
    if (first) {
      first["x"] = x;
      first["y"] = y;
    }
    group["x"] = x;
    group["y"] = y;
  }
}

export interface UpdateGroupArgs {
  skill?: string;
  task?: string;
  /** Spawn only when a trigger activates the group (`activate_group`). */
  lateActivation?: boolean;
  /** Hidden on the F10 map and in the briefing. */
  hidden?: boolean;
  /** Aircraft only: spawned but parked and inert until a trigger starts them. */
  uncontrolled?: boolean;
}

export function updateGroup(mission: LuaTable, name: string, args: UpdateGroupArgs): string[] {
  const { group, category } = requireGroup(mission, name);
  const changed: string[] = [];
  if (args.skill !== undefined) {
    for (const unit of luaArray(group["units"])) unit["skill"] = args.skill;
    changed.push("skill");
  }
  if (args.task !== undefined) {
    group["task"] = args.task;
    changed.push("task");
  }
  if (args.lateActivation !== undefined) {
    group["lateActivation"] = args.lateActivation;
    changed.push("lateActivation");
  }
  if (args.hidden !== undefined) {
    group["hidden"] = args.hidden;
    changed.push("hidden");
  }
  if (args.uncontrolled !== undefined) {
    if (category !== "plane" && category !== "helicopter") {
      throw new Error(`'uncontrolled' applies to aircraft groups only; '${name}' is a ${category} group.`);
    }
    group["uncontrolled"] = args.uncontrolled;
    changed.push("uncontrolled");
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------

function routePoints(mission: LuaTable, groupName: string): { group: LuaTable; points: LuaTable[] } {
  const { group } = requireGroup(mission, groupName);
  return { group, points: luaArray(asTable(group["route"])?.["points"]) };
}

/** Remove waypoint `index` (>= 2). Point 1 is the spawn point and cannot go. */
export function removeWaypoint(mission: LuaTable, groupName: string, index: number): number {
  const { group, points } = routePoints(mission, groupName);
  if (index === 1) {
    throw new Error(
      `Waypoint 1 is the group's spawn point; every group needs it (the Mission Editor cannot open a ` +
        `mission without it). Move the group instead.`
    );
  }
  if (index < 1 || index > points.length) throw new Error(`Group '${groupName}' has no waypoint ${index}`);
  const route = asTable(group["route"]) as LuaTable;
  route["points"] = toList(points.filter((_, i) => i !== index - 1));
  return points.length - 1;
}

export interface UpdateWaypointArgs {
  x?: number;
  y?: number;
  altitudeMetres?: number;
  speedMps?: number;
  name?: string;
}

export function updateWaypoint(mission: LuaTable, groupName: string, index: number, args: UpdateWaypointArgs): void {
  const { points } = routePoints(mission, groupName);
  const point = points[index - 1];
  if (!point) throw new Error(`Group '${groupName}' has no waypoint ${index}`);
  if (index === 1 && (args.x !== undefined || args.y !== undefined)) {
    throw new Error(`Waypoint 1 is the spawn point and moves with the group; use dcs_miz_move_group.`);
  }
  if (args.x !== undefined) point["x"] = args.x;
  if (args.y !== undefined) point["y"] = args.y;
  if (args.altitudeMetres !== undefined) point["alt"] = args.altitudeMetres;
  if (args.speedMps !== undefined) point["speed"] = args.speedMps;
  if (args.name !== undefined) point["name"] = args.name;
}

// ---------------------------------------------------------------------------
// Trigger zones
// ---------------------------------------------------------------------------

function zones(mission: LuaTable): LuaTable[] {
  return luaArray(asTable(mission["triggers"])?.["zones"]);
}

function requireZone(mission: LuaTable, name: string): LuaTable {
  const zone = zones(mission).find((z) => z["name"] === name);
  if (!zone) throw new Error(`No trigger zone named '${name}' in this mission`);
  return zone;
}

export function removeZone(
  mission: LuaTable,
  triggers: MissionTrigger[],
  name: string,
  force = false
): RemovalResult {
  const zone = requireZone(mission, name);
  const zid = typeof zone["zoneId"] === "number" ? (zone["zoneId"] as number) : undefined;
  const refs = triggersReferencing(triggers, "zone", zid);
  if (refs.length && !force) throw refusal(`Zone '${name}'`, refs);
  const table = asTable(mission["triggers"]) as LuaTable;
  table["zones"] = toList(zones(mission).filter((z) => z !== zone));
  return { removed: name, danglingTriggers: refs.map((t) => t.index) };
}

export interface UpdateZoneArgs {
  name?: string;
  x?: number;
  y?: number;
  radius?: number;
  hidden?: boolean;
}

export function updateZone(mission: LuaTable, name: string, args: UpdateZoneArgs): void {
  const zone = requireZone(mission, name);
  if (args.name !== undefined && args.name !== name) {
    if (zones(mission).some((z) => z["name"] === args.name)) {
      throw new Error(`A trigger zone named '${args.name}' already exists`);
    }
    zone["name"] = args.name;
  }
  if (args.x !== undefined || args.y !== undefined) {
    const dx = (args.x ?? Number(zone["x"])) - Number(zone["x"]);
    const dy = (args.y ?? Number(zone["y"])) - Number(zone["y"]);
    zone["x"] = Number(zone["x"]) + dx;
    zone["y"] = Number(zone["y"]) + dy;
    // A quad (polygon) zone carries its own vertices; move them with it.
    for (const v of luaArray(zone["verticies"])) {
      v["x"] = Number(v["x"]) + dx;
      v["y"] = Number(v["y"]) + dy;
    }
  }
  if (args.radius !== undefined) zone["radius"] = args.radius;
  if (args.hidden !== undefined) zone["hidden"] = args.hidden;
}

// ---------------------------------------------------------------------------
// Static objects
// ---------------------------------------------------------------------------

export interface AddStaticArgs {
  side: Side;
  country: string;
  countryId?: number;
  name: string;
  type: string;
  x: number;
  y: number;
  /** Degrees. */
  heading?: number;
  hidden?: boolean;
  /** Placed already destroyed (a wreck). */
  dead?: boolean;
  /** Cargo statics only: mass in kg (sling-loadable cargo). */
  massKg?: number;
  /** Effect statics only (`big_smoke`): which of the editor's presets, 1-8. */
  effectPreset?: number;
  /** Effect statics only: 0 is invisible, 1 is what the editor saves. */
  effectTransparency?: number;
  /** Effect statics only: the editor's own COURSE spinner, in degrees. */
  effectCourseDegrees?: number;
  /** Aircraft, helicopter and ship statics: a livery name, as the editor stores it. */
  liveryId?: string;
  /** Hidden from the mission planner map only. */
  hiddenOnPlanner?: boolean;
  /** Hidden from in-cockpit MFD moving maps only. */
  hiddenOnMFD?: boolean;
}

/**
 * Effect statics: the editor's smoke-and-fire column objects.
 *
 * `big_smoke` is the ONLY one DCS offers. ED's own
 * `Scripts/Database/db_countries.lua` declares `default_Effects = make_unit_list{
 * "big_smoke" }` with `smoky_marker`, `smoking_line` and `dust_smoke` commented
 * out beside it, so the others are not placeable and are not accepted here.
 *
 * It is absent from the pinned pydcs catalogue, which is why it needs naming
 * here at all: without this, the one effect object the editor offers could not
 * be placed. Its fields come from `MissionEditor/modules/me_static.lua`
 * (`effectPreset`, `effectTransparency`, `effectCourse`) and from the presets
 * seen in editor-saved missions.
 */
export const EFFECT_STATICS = new Set(["big_smoke"]);
/**
 * Presets 1-8 are what editor-saved missions carry for `big_smoke`. The
 * editor's own list (`udb.tblPresets`, which also holds its labels and default)
 * is not in any file this project can read, so the labels are not claimed and a
 * preset outside the observed range is refused rather than guessed at.
 */
export const EFFECT_PRESET_RANGE = { min: 1, max: 8 };

/** The `category` a static unit carries, from the catalogue. */
function staticCategory(type: string): { category: string; shape?: string; rate?: number; canCargo?: boolean } {
  if (EFFECT_STATICS.has(type)) return { category: "Effects" };
  const hit = findUnitType(type);
  if (!hit) {
    throw new Error(
      `Unknown static type '${type}'. Find one with dcs_list_unit_types category=static ` +
        `(e.g. 'FARP Ammo Dump Coating', '.Command Center', 'Hangar A'), ` +
        `or '${[...EFFECT_STATICS].join("', '")}' for the editor's smoke effect.`
    );
  }
  switch (hit.category) {
    case "static": {
      const s = hit.entry as StaticType;
      if (s.category === "Heliports") {
        throw new Error(`'${type}' is a heliport; add it with dcs_miz_add_farp so it gets its ATC settings.`);
      }
      return { category: s.category, shape: s.shape ?? undefined, rate: s.rate, canCargo: s.canCargo };
    }
    case "plane":
      return { category: "Planes" };
    case "helicopter":
      return { category: "Helicopters" };
    case "ship":
      return { category: "Ships" };
    case "vehicle":
      return { category: "Vehicles" };
  }
}

/**
 * Add a static object: buildings, fortifications, cargo, parked aircraft as
 * scenery, wrecks. The shape follows pydcs's `static_group`, which writes
 * the same structure the Mission Editor does: a one-unit group under
 * `country.static`, with a single empty route point at its position.
 */
export function addStatic(mission: LuaTable, args: AddStaticArgs): LuaTable {
  const names = allNames(mission);
  if (names.groups.has(args.name)) throw new Error(`A group named '${args.name}' already exists`);
  if (names.units.has(args.name)) throw new Error(`A unit named '${args.name}' already exists`);
  const meta = staticCategory(args.type);
  if (args.massKg !== undefined && !meta.canCargo) {
    throw new Error(`'${args.type}' is not a cargo static; massKg only applies to cargo.`);
  }
  const isEffect = EFFECT_STATICS.has(args.type);
  if (!isEffect && (args.effectPreset !== undefined || args.effectTransparency !== undefined || args.effectCourseDegrees !== undefined)) {
    throw new Error(
      `'${args.type}' is not an effect static; effect settings apply to '${[...EFFECT_STATICS].join("', '")}' only. ` +
        `The editor writes effectPreset on other statics too, but as a vestigial default it does nothing there.`
    );
  }
  if (isEffect) {
    const preset = args.effectPreset;
    if (preset === undefined) {
      throw new Error(
        `'${args.type}' needs effectPreset (${EFFECT_PRESET_RANGE.min}-${EFFECT_PRESET_RANGE.max}): ` +
          `the editor's default comes from a preset table this server cannot read, so it is not assumed.`
      );
    }
    if (!Number.isInteger(preset) || preset < EFFECT_PRESET_RANGE.min || preset > EFFECT_PRESET_RANGE.max) {
      throw new Error(
        `effectPreset must be an integer ${EFFECT_PRESET_RANGE.min}-${EFFECT_PRESET_RANGE.max}; ` +
          `that is the range editor-saved missions use, and nothing documents more.`
      );
    }
    if (args.effectTransparency !== undefined && (args.effectTransparency < 0 || args.effectTransparency > 1)) {
      throw new Error("effectTransparency is 0 to 1");
    }
  }
  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const ids = maxIds(mission);
  const heading = normalizeRadians((args.heading ?? 0) * DEG);
  const unit: LuaTable = {
    name: args.name,
    unitId: ids.unitId + 1,
    type: args.type,
    x: args.x,
    y: args.y,
    heading,
    category: meta.category,
  };
  if (meta.shape) unit["shape_name"] = meta.shape;
  if (meta.rate !== undefined) unit["rate"] = meta.rate;
  if (isEffect && args.effectPreset !== undefined) {
    unit["effectPreset"] = args.effectPreset;
    unit["effectTransparency"] = args.effectTransparency ?? 1;
    if (args.effectCourseDegrees !== undefined) {
      unit["effectCourse"] = args.effectCourseDegrees;
    }
  }
  if (args.liveryId !== undefined) {
    if (!["Planes", "Helicopters", "Ships"].includes(meta.category)) {
      throw new Error(`'${args.type}' is a ${meta.category} static; liveryId applies to aircraft and ships.`);
    }
    unit["livery_id"] = args.liveryId;
  }
  if (meta.canCargo) {
    unit["canCargo"] = true;
    unit["mass"] = args.massKg ?? 1000;
  }
  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    heading,
    x: args.x,
    y: args.y,
    hidden: args.hidden ?? false,
    dead: args.dead ?? false,
    // Written only when asked for: the editor leaves both out by default.
    ...(args.hiddenOnPlanner === undefined ? {} : { hiddenOnPlanner: args.hiddenOnPlanner }),
    ...(args.hiddenOnMFD === undefined ? {} : { hiddenOnMFD: args.hiddenOnMFD }),
    units: { 1: unit },
    route: {
      points: {
        1: { alt: 0, type: "", name: "", x: args.x, y: args.y, speed: 0, formation_template: "", action: "" },
      },
    },
  };
  const catTable = (country["static"] ??= { group: {} }) as LuaTable;
  const groups = (catTable["group"] ??= {}) as LuaTable;
  groups[luaArray(groups).length + 1] = group;
  return group;
}

// ---------------------------------------------------------------------------
// Mission options
// ---------------------------------------------------------------------------

/**
 * Forced options the Mission Editor writes, with their value types. Taken from
 * pydcs's ForcedOptions, which mirrors the editor's list. Keys not listed here
 * that are already in a mission are preserved untouched.
 */
export const FORCED_OPTIONS = {
  permitCrash: "boolean",
  externalViews: "boolean",
  optionsView: ["optview_onlymap", "optview_myaircraft", "optview_allies", "optview_onlyallies", "optview_all"],
  labels: [0, 1, 2, 3, 4],
  easyFlight: "boolean",
  easyRadar: "boolean",
  immortal: "boolean",
  fuel: "boolean",
  weapons: "boolean",
  easyCommunication: "boolean",
  radio: "boolean",
  unrestrictedSATNAV: "boolean",
  padlock: "boolean",
  wakeTurbulence: "boolean",
  geffect: ["none", "reduced", "realistic"],
  accidental_failures: "boolean",
  miniHUD: "boolean",
  cockpitVisualRM: "boolean",
  userMarks: "boolean",
  civTraffic: ["", "low", "medium", "high"],
  birds: "number",
  cockpitStatusBarAllowed: "boolean",
  RBDAI: "boolean",
} as const;

export type ForcedOptionKey = keyof typeof FORCED_OPTIONS;

export interface MissionOptionsArgs {
  date?: { year: number; month: number; day: number };
  /** Seconds after midnight. */
  startTime?: number;
  forcedOptions?: Partial<Record<ForcedOptionKey, boolean | number | string>>;
  /** Remove these forced options (the player's own setting then applies). */
  clearForcedOptions?: ForcedOptionKey[];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function setMissionOptions(mission: LuaTable, args: MissionOptionsArgs): string[] {
  const changed: string[] = [];
  if (args.date) {
    const { year, month, day } = args.date;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new Error(`${year}-${month}-${day} is not a valid date`);
    }
    mission["date"] = { Year: year, Month: month, Day: day };
    changed.push("date");
  }
  if (args.startTime !== undefined) {
    mission["start_time"] = args.startTime;
    changed.push("start_time");
  }
  if (args.forcedOptions || args.clearForcedOptions) {
    const forced = (mission["forcedOptions"] ??= {}) as LuaTable;
    for (const [key, value] of Object.entries(args.forcedOptions ?? {})) {
      const spec = FORCED_OPTIONS[key as ForcedOptionKey];
      if (spec === undefined) throw new Error(`Unknown forced option '${key}'`);
      const ok = Array.isArray(spec) ? (spec as readonly unknown[]).includes(value) : typeof value === spec;
      if (!ok) {
        throw new Error(
          `Forced option '${key}' must be ${Array.isArray(spec) ? `one of ${JSON.stringify(spec)}` : `a ${spec}`}`
        );
      }
      forced[key] = value as LuaValue;
      changed.push(`forcedOptions.${key}`);
    }
    for (const key of args.clearForcedOptions ?? []) {
      delete forced[key];
      changed.push(`forcedOptions.${key} (cleared)`);
    }
  }
  return changed;
}

export interface UnitTypeHit {
  category: string;
  type: string;
  name?: string;
  group?: string;
  tasks?: string[];
  /** "dcs" (bundled catalogue) or "mod:<plugin id>" (installed on this machine). */
  source: string;
}

/**
 * Search the unit catalogue, optionally narrowed to what the Mission Editor
 * offers a country, and including unit mods installed on this machine.
 */
export function searchUnitTypes(
  category: "plane" | "helicopter" | "vehicle" | "ship" | "static" | undefined,
  query: string | undefined,
  limit: number,
  options: { country?: string; includeMods?: boolean } = {}
): UnitTypeHit[] {
  const all = unitTypes();
  const cats = category ? [category] : (Object.keys(all) as (keyof typeof all)[]);
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const matches = (hay: string) => words.every((w) => hay.toLowerCase().includes(w));
  const country = options.country ? findCountry(options.country) : undefined;
  if (options.country && !country) throw new Error(`Unknown country '${options.country}' (see dcs_list_countries).`);
  const out: UnitTypeHit[] = [];
  for (const c of cats) {
    const offered = country && c !== "static" ? new Set(country.units[c as keyof typeof country.units]) : undefined;
    for (const t of all[c] as { type: string; name?: string; group?: string; tasks?: string[] }[]) {
      if (offered && !offered.has(t.type)) continue;
      if (!matches(`${t.type} ${t.name ?? ""} ${t.group ?? ""}`)) continue;
      out.push({ category: c, type: t.type, name: t.name, group: t.group, tasks: t.tasks, source: "dcs" });
      if (out.length >= limit) return out;
    }
  }
  if (options.includeMods !== false) {
    // Mods only ADD types: one that reuses a DCS type id is the DCS type, not a mod.
    for (const mod of installedMods()) {
      for (const u of mod.units) {
        if (findUnitType(u.type)) continue;
        const cat = u.category === "unknown" ? "plane" : u.category;
        if (category && category !== cat) continue;
        if (!matches(`${u.type} ${mod.id}`)) continue;
        out.push({ category: cat, type: u.type, group: mod.kind, source: `mod:${mod.id}` });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
