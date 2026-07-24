/**
 * Mission authoring mutations.
 *
 * These operate directly on the raw parsed `mission` Lua table so that every
 * unsupported field is preserved for a lossless round-trip. Only the serializer
 * writes data out. Positions are given in DCS internal x/y metres offline; use the
 * live dcs_convert_coords tool to turn lat/long into x/y when DCS is running.
 */
import { asTable, luaArray, type LuaTable, type LuaValue } from "./lua.js";

export type Side = "red" | "blue" | "neutrals";
export type AirCategory = "plane" | "helicopter";
export type GroundCategory = "vehicle" | "ship";

/** Common DCS country ids, enough to author for the major factions. */
const COUNTRY_IDS: Record<string, number> = {
  russia: 0,
  ukraine: 1,
  usa: 2,
  turkey: 3,
  uk: 4,
  france: 5,
  germany: 6,
  georgia: 9,
  israel: 15,
  iran: 17,
  china: 34,
};

export function countryId(name: string, override?: number): number {
  if (override !== undefined) return override;
  return COUNTRY_IDS[name.toLowerCase()] ?? 2;
}

function nextIndex(table: LuaTable | undefined): number {
  return luaArray(table).length + 1;
}

/** Ensure coalition[side].country array exists and return the country subtable. */
function ensureCountry(mission: LuaTable, side: Side, country: string, id: number): LuaTable {
  const coalitions = (mission["coalition"] ??= {}) as LuaTable;
  const sideTable = (coalitions[side] ??= { name: side, country: {} }) as LuaTable;
  const countries = (sideTable["country"] ??= {}) as LuaTable;

  for (const entry of luaArray(countries)) {
    if (entry["name"] === country) return entry;
  }
  const created: LuaTable = { id, name: country };
  countries[nextIndex(countries)] = created;
  return created;
}

/**
 * Highest `groupId`/`unitId` already used anywhere in the mission.
 *
 * DCS identifies groups and units by these integers, not by name, and they must
 * be unique mission-wide. New content continues the existing numbering so an
 * authored mission stays consistent with one that came out of the Mission Editor.
 */
export function maxIds(mission: LuaTable): { groupId: number; unitId: number } {
  let maxGroup = 0;
  let maxUnit = 0;
  const coalitions = asTable(mission["coalition"]);
  for (const side of ["red", "blue", "neutrals"] as Side[]) {
    const sideTable = asTable(coalitions?.[side]);
    for (const country of luaArray(sideTable?.["country"])) {
      for (const category of ALL_CATEGORIES) {
        const catTable = asTable(country[category]);
        for (const group of luaArray(catTable?.["group"])) {
          const gid = group["groupId"];
          if (typeof gid === "number" && gid > maxGroup) maxGroup = gid;
          for (const unit of luaArray(group["units"])) {
            const uid = unit["unitId"];
            if (typeof uid === "number" && uid > maxUnit) maxUnit = uid;
          }
        }
      }
    }
  }
  return { groupId: maxGroup, unitId: maxUnit };
}

interface UnitSpec {
  type: string;
  x: number;
  y: number;
  altitudeMetres?: number;
  heading?: number;
  skill?: string;
  /** First `unitId` to assign; subsequent units increment from here. */
  firstUnitId: number;
}

function buildUnits(groupName: string, count: number, spec: UnitSpec): LuaTable {
  const units: LuaTable = {};
  for (let i = 1; i <= count; i++) {
    const unit: LuaTable = {
      name: `${groupName}-${i}`,
      unitId: spec.firstUnitId + i - 1,
      type: spec.type,
      x: spec.x + (i - 1) * 30,
      y: spec.y + (i - 1) * 30,
      heading: spec.heading ?? 0,
      skill: spec.skill ?? "High",
    };
    if (spec.altitudeMetres !== undefined) {
      unit["alt"] = spec.altitudeMetres;
      unit["alt_type"] = "BARO";
    }
    units[i] = unit;
  }
  return units;
}

export interface AddGroupArgs {
  side: Side;
  country: string;
  countryId?: number;
  name: string;
  type: string;
  count: number;
  x: number;
  y: number;
  altitudeMetres?: number;
  heading?: number;
  skill?: string;
  task?: string;
}

/** Add a fixed-wing or helicopter group. Returns the created group table. */
export function addAircraftGroup(mission: LuaTable, category: AirCategory, args: AddGroupArgs): LuaTable {
  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const catTable = (country[category] ??= { group: {} }) as LuaTable;
  const groups = (catTable["group"] ??= {}) as LuaTable;
  const ids = maxIds(mission);

  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    task: args.task ?? "CAP",
    task_started: false,
    units: buildUnits(args.name, args.count, {
      type: args.type,
      x: args.x,
      y: args.y,
      altitudeMetres: args.altitudeMetres ?? 6096,
      heading: args.heading,
      skill: args.skill,
      firstUnitId: ids.unitId + 1,
    }),
    route: { points: {} },
    x: args.x,
    y: args.y,
  };
  groups[nextIndex(groups)] = group;
  return group;
}

/** Add a ground-vehicle or ship group. Returns the created group table. */
export function addGroundGroup(mission: LuaTable, category: GroundCategory, args: AddGroupArgs): LuaTable {
  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const catTable = (country[category] ??= { group: {} }) as LuaTable;
  const groups = (catTable["group"] ??= {}) as LuaTable;
  const ids = maxIds(mission);

  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    task: args.task ?? "Ground Nothing",
    units: buildUnits(args.name, args.count, {
      type: args.type,
      x: args.x,
      y: args.y,
      heading: args.heading,
      skill: args.skill ?? "Average",
      firstUnitId: ids.unitId + 1,
    }),
    route: { points: {} },
    x: args.x,
    y: args.y,
  };
  groups[nextIndex(groups)] = group;
  return group;
}

export interface AddZoneArgs {
  name: string;
  x: number;
  y: number;
  radius: number;
}

/** Add a circular trigger zone. */
export function addTriggerZone(mission: LuaTable, args: AddZoneArgs): LuaTable {
  const triggers = (mission["triggers"] ??= { zones: {} }) as LuaTable;
  const zones = (triggers["zones"] ??= {}) as LuaTable;
  const zone: LuaTable = {
    name: args.name,
    x: args.x,
    y: args.y,
    radius: args.radius,
    hidden: false,
    type: 0,
    color: { 1: 1, 2: 1, 3: 1, 4: 0.15 },
  };
  zones[nextIndex(zones)] = zone;
  return zone;
}

export interface WeatherArgs {
  temperatureCelsius?: number;
  qnhMmHg?: number;
  cloudBaseMetres?: number;
  windGroundSpeed?: number;
  windGroundDir?: number;
}

/** Update supported weather fields, creating tables as needed. */
export function setWeather(mission: LuaTable, args: WeatherArgs): void {
  const weather = (mission["weather"] ??= {}) as LuaTable;
  if (args.temperatureCelsius !== undefined) {
    const season = (weather["season"] ??= {}) as LuaTable;
    season["temperature"] = args.temperatureCelsius;
  }
  if (args.qnhMmHg !== undefined) weather["qnh"] = args.qnhMmHg;
  if (args.cloudBaseMetres !== undefined) {
    const clouds = (weather["clouds"] ??= {}) as LuaTable;
    clouds["base"] = args.cloudBaseMetres;
  }
  if (args.windGroundSpeed !== undefined || args.windGroundDir !== undefined) {
    const wind = (weather["wind"] ??= {}) as LuaTable;
    const atGround = (wind["atGround"] ??= {}) as LuaTable;
    if (args.windGroundSpeed !== undefined) atGround["speed"] = args.windGroundSpeed;
    if (args.windGroundDir !== undefined) atGround["dir"] = args.windGroundDir;
  }
}

/** Set briefing title/description as literal text (no dictionary indirection). */
export function setBriefing(mission: LuaTable, title?: string, description?: string): void {
  if (title !== undefined) mission["sortie"] = title;
  if (description !== undefined) mission["descriptionText"] = description;
}

const AIR_CATEGORIES = ["plane", "helicopter"];
const ALL_CATEGORIES = ["plane", "helicopter", "vehicle", "ship", "static"];

export interface FoundGroup {
  group: LuaTable;
  category: string;
  side: Side;
  country: LuaTable;
}

/** Locate a group by name across every coalition/country/category. */
export function findGroup(mission: LuaTable, name: string): FoundGroup | undefined {
  const coalitions = asTable(mission["coalition"]);
  for (const side of ["red", "blue", "neutrals"] as Side[]) {
    const sideTable = asTable(coalitions?.[side]);
    for (const country of luaArray(sideTable?.["country"])) {
      for (const category of ALL_CATEGORIES) {
        const catTable = asTable(country[category]);
        for (const group of luaArray(catTable?.["group"])) {
          if (group["name"] === name) return { group, category, side, country };
        }
      }
    }
  }
  return undefined;
}

/** Locate a unit by name across every group. */
export function findUnit(mission: LuaTable, name: string): LuaTable | undefined {
  const coalitions = asTable(mission["coalition"]);
  for (const side of ["red", "blue", "neutrals"] as Side[]) {
    const sideTable = asTable(coalitions?.[side]);
    for (const country of luaArray(sideTable?.["country"])) {
      for (const category of ALL_CATEGORIES) {
        const catTable = asTable(country[category]);
        for (const group of luaArray(catTable?.["group"])) {
          for (const unit of luaArray(group["units"])) {
            if (unit["name"] === name) return unit;
          }
        }
      }
    }
  }
  return undefined;
}

export interface WaypointArgs {
  x: number;
  y: number;
  altitudeMetres?: number;
  speedMps?: number;
  type?: string;
  action?: string;
  name?: string;
}

/** Append a route waypoint to a group. Throws if the group is not found. */
export function addWaypoint(mission: LuaTable, groupName: string, wp: WaypointArgs): number {
  const found = findGroup(mission, groupName);
  if (!found) throw new Error(`No group named '${groupName}' in this mission`);
  const isAir = AIR_CATEGORIES.includes(found.category);
  const route = (found.group["route"] ??= { points: {} }) as LuaTable;
  const points = (route["points"] ??= {}) as LuaTable;
  const point: LuaTable = {
    x: wp.x,
    y: wp.y,
    alt: wp.altitudeMetres ?? (isAir ? 6096 : 0),
    alt_type: "BARO",
    type: wp.type ?? (isAir ? "Turning Point" : "Turning Point"),
    action: wp.action ?? (isAir ? "Turning Point" : "Off Road"),
    speed: wp.speedMps ?? (isAir ? 220 : 20),
    speed_locked: true,
    ETA: 0,
    ETA_locked: false,
    name: wp.name ?? "",
    formation_template: "",
    task: { id: "ComboTask", params: { tasks: {} } },
  };
  const index = nextIndex(points);
  points[index] = point;
  return index;
}

export interface PayloadArgs {
  fuel?: number;
  flare?: number;
  chaff?: number;
  gun?: number;
  pylons?: { pylon: number; CLSID: string }[];
}

/** Set a unit's payload/loadout. Throws if the unit is not found. */
export function setPayload(mission: LuaTable, unitName: string, args: PayloadArgs): void {
  const unit = findUnit(mission, unitName);
  if (!unit) throw new Error(`No unit named '${unitName}' in this mission`);
  const payload = (unit["payload"] ??= { pylons: {}, fuel: "0", flare: 0, chaff: 0, gun: 100 }) as LuaTable;
  if (args.fuel !== undefined) payload["fuel"] = String(args.fuel); // DCS stores fuel as a string
  if (args.flare !== undefined) payload["flare"] = args.flare;
  if (args.chaff !== undefined) payload["chaff"] = args.chaff;
  if (args.gun !== undefined) payload["gun"] = args.gun;
  if (args.pylons) {
    const pylons: LuaTable = {};
    for (const p of args.pylons) pylons[p.pylon] = { CLSID: p.CLSID };
    payload["pylons"] = pylons;
  }
}

/** Set a group's primary task string (e.g. 'CAP', 'CAS', 'SEAD'). */
export function setGroupTask(mission: LuaTable, groupName: string, task: string): void {
  const found = findGroup(mission, groupName);
  if (!found) throw new Error(`No group named '${groupName}' in this mission`);
  found.group["task"] = task;
}

export type TriggerType = "start" | "once" | "continuous";
export type ConditionSpec =
  | { kind: "time_after"; seconds: number }
  | { kind: "flag_is_true"; flag: number }
  | { kind: "flag_equals"; flag: number; value: number };
export type ActionSpec =
  | { kind: "message"; text: string; seconds?: number }
  | { kind: "set_flag"; flag: number; value?: number }
  | { kind: "activate_group"; group: string }
  | { kind: "end_mission"; winner: Side };

const TRIGGER_PREDICATE: Record<TriggerType, string> = {
  start: "triggerStart",
  once: "triggerOnce",
  continuous: "triggerContinious", // DCS spells it this way in the file format
};

function conditionRule(c: ConditionSpec): LuaTable {
  switch (c.kind) {
    case "time_after":
      return { predicate: "c_time_after", seconds: c.seconds, comment: "" };
    case "flag_is_true":
      return { predicate: "c_flag_is_true", flag: c.flag, comment: "" };
    case "flag_equals":
      return { predicate: "c_flag_equals", flag: c.flag, value: c.value, comment: "" };
  }
}

function actionRule(a: ActionSpec): LuaTable {
  switch (a.kind) {
    case "message":
      return { predicate: "a_out_text", text: a.text, seconds: a.seconds ?? 10, clearview: false };
    case "set_flag":
      return { predicate: "a_set_flag_value", flag: a.flag, value: a.value ?? 1 };
    case "activate_group":
      return { predicate: "a_activate_group", group: a.group };
    case "end_mission":
      return { predicate: "a_end_mission", winner: a.winner, comment: "" };
  }
}

export interface TriggerArgs {
  type: TriggerType;
  comment?: string;
  conditions: ConditionSpec[];
  actions: ActionSpec[];
}

/**
 * Add a mission trigger in the Mission Editor's STRUCTURED form (`trigrules`).
 * DCS regenerates the compiled runtime triggers (`trig`) when the mission is
 * opened and saved in the Mission Editor, so finalize triggers there.
 */
export function addTrigger(mission: LuaTable, args: TriggerArgs): number {
  const trigrules = (mission["trigrules"] ??= {}) as LuaTable;
  const rules: LuaTable = {};
  args.conditions.forEach((c, i) => {
    rules[i + 1] = conditionRule(c);
  });
  const actions: LuaTable = {};
  args.actions.forEach((a, i) => {
    actions[i + 1] = actionRule(a);
  });
  const index = nextIndex(trigrules);
  trigrules[index] = {
    predicate: TRIGGER_PREDICATE[args.type],
    comment: args.comment ?? "",
    colorItem: "0x00ff00ff",
    eventlist: "",
    rules,
    actions,
  };
  return index;
}

/** A minimal, best-effort new-mission table. Finalize in the DCS Mission Editor. */
export function newMissionTable(theatre: string, startTime: number): LuaTable {
  const emptySide = (name: string): LuaTable => ({ name, country: {}, nav_points: {}, bullseye: { x: 0, y: 0 } });
  return {
    version: 19,
    theatre,
    start_time: startTime,
    date: { Year: 2016, Month: 6, Day: 1 },
    weather: {
      season: { temperature: 20 },
      qnh: 760,
      clouds: { base: 1200, density: 0, thickness: 200, iprecptns: 0 },
      wind: { atGround: { speed: 0, dir: 0 }, at2000: { speed: 0, dir: 0 }, at8000: { speed: 0, dir: 0 } },
      groundTurbulence: 0,
      enable_fog: false,
      type_weather: 0,
    },
    coalition: { blue: emptySide("blue"), red: emptySide("red"), neutrals: emptySide("neutrals") },
    coalitions: { blue: {}, red: {}, neutrals: {} },
    triggers: { zones: {} },
    trig: { actions: {}, conditions: {}, custom: {}, events: {}, flag: {}, func: {}, funcStartup: {} },
    trigrules: {},
    result: { blue: { conditions: {}, actions: {}, func: {} }, red: { conditions: {}, actions: {}, func: {} } },
    groundControl: { roles: {}, passwords: {} },
    forcedOptions: {},
    failures: {},
    goals: {},
    map: { zoom: 1000000, centerX: 0, centerY: 0 },
    descriptionText: "",
    descriptionBlueTask: "",
    descriptionRedTask: "",
    sortie: "",
    maxDictId: 0,
    requiredModules: {},
    currentKey: 0,
  } as unknown as LuaTable;
}

/** Read a top-level table for null-safety in tools. */
export function missionSection(mission: LuaTable, key: string): LuaValue | undefined {
  return asTable(mission[key]);
}
