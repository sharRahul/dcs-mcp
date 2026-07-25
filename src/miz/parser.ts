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
    id: num(unit["unitId"]),
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
    id: num(group["groupId"]),
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
    id: num(z["zoneId"]),
    x: num(z["x"]) ?? 0,
    y: num(z["y"]) ?? 0,
    radius: num(z["radius"]),
    type: num(z["type"]) === 2 ? "polygon" : "circle",
  }));
}

// Which predicates carry a real cross-reference in a given field. The Mission
// Editor also writes vestigial `zone`/`unit`/`group` values on predicates that
// ignore them, so reference checks must be driven by these lists rather than by
// "this rule happens to have a zone field".

/** Predicates whose `group` field points at a group in the mission. */
const GROUP_REF_PREDICATES = new Set([
  "a_activate_group",
  "a_deactivate_group",
  "a_group_on",
  "a_group_off",
  "a_group_resume",
  "a_ai_task",
  "a_set_ai_task",
  "a_out_text_delay_g",
  "a_out_sound_g",
  "c_group_dead",
  "c_group_life_less",
  "c_part_of_group_in_zone",
  "c_all_of_group_in_zone",
]);

/** Predicates whose `zone` field points at a trigger zone. */
const ZONE_REF_PREDICATES = new Set([
  "c_unit_in_zone",
  "c_unit_out_zone",
  "c_part_of_coalition_in_zone",
  "c_part_of_group_in_zone",
  "c_all_of_group_in_zone",
  "c_missile_in_zone",
  "c_bomb_in_zone",
  "c_dead_zone",
  "a_explosion",
  "a_effect_smoke",
  "a_signal_flare",
  "a_radio_transmission",
]);

/** Predicates whose `unit` field points at a unit in the mission. */
const UNIT_REF_PREDICATES = new Set([
  "c_unit_in_zone",
  "c_unit_out_zone",
  "c_unit_dead",
  "c_unit_alive",
  "c_unit_damaged",
  "c_unit_altitude_lower_AGL",
  "c_unit_altitude_higher_AGL",
]);

/** Predicates whose `flag` field names a mission flag. */
const FLAG_REF_PREDICATES = new Set([
  "c_flag_is_true",
  "c_flag_is_false",
  "c_flag_equals",
  "c_flag_more",
  "c_time_since_flag",
  "a_set_flag",
  "a_set_flag_value",
  "a_clear_flag",
  "a_set_flag_random",
]);

/** Collect the cross-references each trigger makes, for reference validation. */
function parseTriggers(mission: LuaTable): MissionTrigger[] {
  const compiledActions = asTable(asTable(mission["trig"])?.["actions"]);

  return luaArray(mission["trigrules"]).map((rule, i) => {
    const groupRefs: (string | number)[] = [];
    const zoneRefs: (string | number)[] = [];
    const unitRefs: (string | number)[] = [];
    const flagRefs: (string | number)[] = [];

    const collect = (entry: LuaTable) => {
      const predicate = str(entry["predicate"]);
      if (!predicate) return;
      const push = (target: (string | number)[], field: string, allowed: Set<string>) => {
        const ref = entry[field];
        if (allowed.has(predicate) && (typeof ref === "string" || typeof ref === "number")) {
          target.push(ref);
        }
      };
      push(groupRefs, "group", GROUP_REF_PREDICATES);
      push(zoneRefs, "zone", ZONE_REF_PREDICATES);
      push(unitRefs, "unit", UNIT_REF_PREDICATES);
      push(flagRefs, "flag", FLAG_REF_PREDICATES);
    };

    for (const action of luaArray(rule["actions"])) collect(action);
    for (const condition of luaArray(rule["rules"])) collect(condition);

    return {
      index: i + 1,
      predicate: str(rule["predicate"]) ?? "unknown",
      comment: str(rule["comment"]) || undefined,
      groupRefs,
      zoneRefs,
      unitRefs,
      flagRefs,
      compiled: typeof compiledActions?.[i + 1] === "string",
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
  mapResource?: LuaTable;
} {
  const missionSrc = archive.entries.get("mission");
  if (!missionSrc) {
    throw new Error("Archive does not contain a 'mission' entry; not a DCS mission file");
  }
  const mission = parseLuaAssignment(missionSrc, "mission");
  const dictSrc = archive.entries.get("l10n/DEFAULT/dictionary");
  const dictionary = dictSrc ? parseLuaAssignment(dictSrc, "dictionary") : undefined;
  const resSrc = archive.entries.get("l10n/DEFAULT/mapResource");
  const mapResource = resSrc ? parseLuaAssignment(resSrc, "mapResource") : undefined;
  return { mission, dictionary, mapResource };
}

/** Build the canonical MissionDocument from a validated archive. */
export function parseMission(archive: MizArchive): MissionDocument {
  const { mission, dictionary } = parseMissionTables(archive);
  return buildMissionDocument(mission, dictionary, archive.digest);
}
