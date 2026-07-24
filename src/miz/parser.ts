/**
 * Parse a validated `.miz` archive into the canonical MissionDocument model.
 * Only supported, well-understood structures are mapped; unknown content is ignored.
 */
import { parseLuaAssignment, luaArray, asTable, type LuaTable, type LuaValue } from "./lua.js";
import type { MizArchive } from "./archive.js";
import type {
  Coalition,
  GroupCategory,
  MissionDocument,
  MissionGroup,
  MissionSummary,
  MissionTrigger,
  MissionUnit,
  MissionWeather,
  TriggerZone,
} from "../types.js";

const COALITIONS: Coalition[] = ["red", "blue", "neutrals"];
const GROUP_CATEGORIES: GroupCategory[] = ["plane", "helicopter", "ship", "vehicle", "static"];

function num(v: LuaValue | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function str(v: LuaValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Resolve a possible dictionary reference ("DictKey_...") to its localized text. */
function makeResolver(dictionary: LuaTable | undefined): (v: LuaValue | undefined) => string | undefined {
  return (v) => {
    const s = str(v);
    if (s === undefined) return undefined;
    if (dictionary && s.startsWith("DictKey_") && typeof dictionary[s] === "string") {
      return dictionary[s] as string;
    }
    return s;
  };
}

function parseWeather(weather: LuaTable | undefined): MissionWeather {
  if (!weather) return {};
  const wind = asTable(weather["wind"]);
  const atGround = asTable(wind?.["atGround"]);
  return {
    temperatureCelsius: num(asTable(weather["season"])?.["temperature"]),
    qnhMmHg: num(weather["qnh"]),
    cloudsBase: num(asTable(weather["clouds"])?.["base"]),
    windGroundSpeed: num(atGround?.["speed"]),
    windGroundDir: num(atGround?.["dir"]),
    turbulence: num(weather["groundTurbulence"]),
  };
}

function parseUnit(unit: LuaTable, resolve: (v: LuaValue | undefined) => string | undefined): MissionUnit {
  return {
    name: resolve(unit["name"]) ?? "(unnamed)",
    type: str(unit["type"]) ?? "unknown",
    skill: str(unit["skill"]),
    x: num(unit["x"]) ?? 0,
    y: num(unit["y"]) ?? 0,
    altitudeMetres: num(unit["alt"]),
    heading: num(unit["heading"]),
  };
}

function parseGroup(
  group: LuaTable,
  category: GroupCategory,
  coalition: Coalition,
  country: string,
  resolve: (v: LuaValue | undefined) => string | undefined
): MissionGroup {
  const units = luaArray(group["units"]).map((u) => parseUnit(u, resolve));
  const points = luaArray(asTable(group["route"])?.["points"]);
  return {
    name: resolve(group["name"]) ?? "(unnamed group)",
    category,
    coalition,
    country,
    task: str(group["task"]),
    units,
    waypointCount: points.length,
  };
}

function parseGroups(mission: LuaTable, resolve: (v: LuaValue | undefined) => string | undefined) {
  const groups: MissionGroup[] = [];
  const countriesByCoalition: Record<string, string[]> = {};
  const coalitionRoot = asTable(mission["coalition"]);

  for (const coalition of COALITIONS) {
    const side = asTable(coalitionRoot?.[coalition]);
    if (!side) continue;
    const countries = luaArray(side["country"]);
    for (const country of countries) {
      const countryName = str(country["name"]) ?? "unknown";
      (countriesByCoalition[coalition] ??= []).push(countryName);
      for (const category of GROUP_CATEGORIES) {
        const catTable = asTable(country[category]);
        for (const group of luaArray(catTable?.["group"])) {
          groups.push(parseGroup(group, category, coalition, countryName, resolve));
        }
      }
    }
  }
  return { groups, countriesByCoalition };
}

function parseZones(mission: LuaTable, resolve: (v: LuaValue | undefined) => string | undefined): TriggerZone[] {
  const zones = luaArray(asTable(mission["triggers"])?.["zones"]);
  return zones.map((z) => ({
    name: resolve(z["name"]) ?? "(unnamed zone)",
    x: num(z["x"]) ?? 0,
    y: num(z["y"]) ?? 0,
    radius: num(z["radius"]),
    type: num(z["type"]) === 2 ? "polygon" : "circle",
  }));
}

/** Action predicates whose `group` field points at another group in the mission. */
const GROUP_REF_ACTIONS = new Set([
  "a_activate_group",
  "a_deactivate_group",
  "a_group_activate",
  "a_group_deactivate",
  "a_group_stop",
  "a_group_continue",
]);

/** Condition predicates whose `zone` field points at a trigger zone. */
const ZONE_REF_CONDITIONS = new Set([
  "c_unit_in_zone",
  "c_part_of_coalition_in_zone",
  "c_all_of_coalition_in_zone",
  "c_unit_outside_zone",
  "c_group_in_zone",
]);

/** Collect the cross-references each trigger makes, for reference validation. */
function parseTriggers(mission: LuaTable): MissionTrigger[] {
  return luaArray(mission["trigrules"]).map((rule, i) => {
    const groupRefs: (string | number)[] = [];
    const zoneRefs: (string | number)[] = [];

    for (const action of luaArray(rule["actions"])) {
      const predicate = str(action["predicate"]);
      const ref = action["group"];
      if (predicate && GROUP_REF_ACTIONS.has(predicate) && (typeof ref === "string" || typeof ref === "number")) {
        groupRefs.push(ref);
      }
    }
    for (const condition of luaArray(rule["rules"])) {
      const predicate = str(condition["predicate"]);
      const ref = condition["zone"];
      if (
        predicate &&
        ZONE_REF_CONDITIONS.has(predicate) &&
        (typeof ref === "string" || typeof ref === "number")
      ) {
        zoneRefs.push(ref);
      }
    }

    return {
      index: i + 1,
      predicate: str(rule["predicate"]) ?? "unknown",
      comment: str(rule["comment"]) || undefined,
      groupRefs,
      zoneRefs,
    };
  });
}

/** Build the canonical MissionDocument from already-parsed mission/dictionary tables. */
export function buildMissionDocument(
  mission: LuaTable,
  dictionary: LuaTable | undefined,
  sourceDigest: string
): MissionDocument {
  const resolve = makeResolver(dictionary);

  const theatre = str(mission["theatre"]) ?? "unknown";
  const weather = parseWeather(asTable(mission["weather"]));
  const { groups, countriesByCoalition } = parseGroups(mission, resolve);
  const zones = parseZones(mission, resolve);
  const triggers = parseTriggers(mission);
  const triggerCount = triggers.length;

  const briefingTitle = resolve(mission["sortie"]);
  const briefingDescription = resolve(mission["descriptionText"]);

  const dateTable = asTable(mission["date"]);
  const date = dateTable
    ? { Year: num(dateTable["Year"]) ?? 0, Month: num(dateTable["Month"]) ?? 0, Day: num(dateTable["Day"]) ?? 0 }
    : undefined;

  const summary: MissionSummary = {
    theatre,
    start_time: num(mission["start_time"]),
    date,
    coalitions: COALITIONS.filter((c) => countriesByCoalition[c]?.length),
    countriesByCoalition,
    groupCount: groups.length,
    unitCount: groups.reduce((n, g) => n + g.units.length, 0),
    zoneCount: zones.length,
    triggerCount,
    weather,
    briefingTitle,
  };

  return {
    theatre,
    summary,
    groups,
    zones,
    triggers,
    weather,
    briefing: { title: briefingTitle, description: briefingDescription },
    sourceDigest,
  };
}

/** Parse the mission + dictionary entries of an archive into tables. */
export function parseMissionTables(archive: MizArchive): {
  mission: LuaTable;
  dictionary?: LuaTable;
} {
  const missionSrc = archive.entries.get("mission");
  if (!missionSrc) {
    throw new Error("Archive does not contain a 'mission' entry; not a DCS mission file");
  }
  const mission = parseLuaAssignment(missionSrc, "mission");
  const dictSrc = archive.entries.get("l10n/DEFAULT/dictionary");
  const dictionary = dictSrc ? parseLuaAssignment(dictSrc, "dictionary") : undefined;
  return { mission, dictionary };
}

/** Build the canonical MissionDocument from a validated archive. */
export function parseMission(archive: MizArchive): MissionDocument {
  const { mission, dictionary } = parseMissionTables(archive);
  return buildMissionDocument(mission, dictionary, archive.digest);
}
