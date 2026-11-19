/**
 * Mission authoring mutations.
 *
 * These operate directly on the raw parsed `mission` Lua table so that every
 * unsupported field is preserved for a lossless round-trip. Only the serializer
 * writes data out. Positions are given in DCS internal x/y metres offline; use the
 * live dcs_convert_coords tool to turn lat/long into x/y when DCS is running.
 */
import { asTable, luaArray, type LuaTable, type LuaValue } from "./lua.js";
import { authoringData } from "../data/authoring.js";
import { quoteLuaString } from "./serializer.js";
import { nextDictId } from "./resources.js";
import { callsignOptions } from "./callsigns.js";
import {
  findAirport,
  findCountry,
  findCountryById,
  findUnitType,
  resolveTheatreName,
  SLOT_AIRPLANES,
  SLOT_HELI,
  type Airport,
  type FlyingType,
} from "../data/reference.js";

export type Side = "red" | "blue" | "neutrals";
export type AirCategory = "plane" | "helicopter";
export type GroundCategory = "vehicle" | "ship";

/**
 * Resolve a country name (or short code) to its DCS id from the bundled list of
 * every DCS country. An unknown name is an error: silently defaulting (the old
 * behaviour fell back to USA) put units under the wrong flag with no warning.
 */
export function countryId(name: string, override?: number): number {
  if (override !== undefined) return override;
  const hit = findCountry(name);
  if (!hit) {
    throw new Error(
      `Unknown country '${name}'. Use the exact DCS name (dcs_list_countries), e.g. 'USA', 'Russia', ` +
        `'Combined Joint Task Forces Blue', or pass countryId.`
    );
  }
  return hit.id;
}

/** The name DCS writes for a country: canonical when we know the id. */
function canonicalCountryName(name: string, id: number): string {
  return findCountryById(id)?.name ?? name;
}

function nextIndex(table: LuaTable | undefined): number {
  return luaArray(table).length + 1;
}

/**
 * Ensure coalition[side].country has this country and return its subtable.
 *
 * A country belongs to exactly one side, so asking for it on another side is an
 * error rather than a second copy. The Mission Editor also keeps a per-side list
 * of country ids in `mission.coalitions`; it is kept in step here so the editor's
 * coalition screen agrees with where the units actually are.
 */
export function ensureCountry(mission: LuaTable, side: Side, country: string, id: number): LuaTable {
  const coalitions = (mission["coalition"] ??= {}) as LuaTable;
  for (const other of ["red", "blue", "neutrals"] as Side[]) {
    if (other === side) continue;
    for (const entry of luaArray(asTable(coalitions[other])?.["country"])) {
      if (entry["id"] === id || entry["name"] === country) {
        throw new Error(
          `Country '${entry["name"]}' is already on the ${other} side; a country can only belong to one ` +
            `coalition. Use another country for ${side} (e.g. 'Combined Joint Task Forces ` +
            `${side === "red" ? "Red" : "Blue"}').`
        );
      }
    }
  }
  const sideTable = (coalitions[side] ??= { name: side, country: {} }) as LuaTable;
  const countries = (sideTable["country"] ??= {}) as LuaTable;

  for (const entry of luaArray(countries)) {
    if (entry["id"] === id || entry["name"] === country) return entry;
  }
  const created: LuaTable = { id, name: canonicalCountryName(country, id) };
  countries[nextIndex(countries)] = created;
  assignCountryToSide(mission, side, id);
  return created;
}

/** Keep `mission.coalitions.<side>` (the ME's id lists) consistent, if present. */
function assignCountryToSide(mission: LuaTable, side: Side, id: number): void {
  const lists = asTable(mission["coalitions"]);
  if (!lists) return;
  for (const other of ["red", "blue", "neutrals"] as Side[]) {
    const list = asTable(lists[other]);
    if (!list || other === side) continue;
    const kept = luaArray(list).map((e) => e["value"]).filter((v) => v !== id);
    if (kept.length !== luaArray(list).length) lists[other] = toLuaList(kept as LuaValue[]);
  }
  const mine = (lists[side] ??= {}) as LuaTable;
  const ids = luaArray(mine).map((e) => e["value"]);
  if (!ids.includes(id)) mine[ids.length + 1] = id;
}

function toLuaList(values: LuaValue[]): LuaTable {
  const out: LuaTable = {};
  values.forEach((v, i) => {
    out[i + 1] = v;
  });
  return out;
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

/**
 * Per-category defaults for a route point, taken from Mission-Editor-saved
 * missions (ground units cruise at 5.5556 m/s = 20 km/h, and so on).
 */
const ROUTE_DEFAULTS: Record<string, { type: string; action: string; speed: number; alt: number }> = {
  plane: { type: "Turning Point", action: "Turning Point", speed: 220, alt: 6096 },
  helicopter: { type: "Turning Point", action: "Turning Point", speed: 46.25, alt: 500 },
  vehicle: { type: "Turning Point", action: "Off Road", speed: 5.5555555555556, alt: 0 },
  ship: { type: "Turning Point", action: "Turning Point", speed: 0, alt: 0 },
};

export interface RoutePointSpec {
  x: number;
  y: number;
  alt: number;
  speed: number;
  type: string;
  action: string;
  name?: string;
  /**
   * The editor's "fix time" checkbox. Only the first point — the mission start —
   * is ETA-locked in an ME-saved route; locking later waypoints pins each one to
   * a computed arrival time, which the editor shows as a red ETA the moment any
   * earlier leg changes. Defaults to false; `initialRoute` passes true.
   */
  etaLocked?: boolean;
}

/** Build one route point in the shape the Mission Editor writes. */
function routePoint(spec: RoutePointSpec): LuaTable {
  return {
    x: spec.x,
    y: spec.y,
    alt: spec.alt,
    alt_type: "BARO",
    type: spec.type,
    action: spec.action,
    speed: spec.speed,
    speed_locked: true,
    ETA: 0,
    ETA_locked: spec.etaLocked ?? false,
    name: spec.name ?? "",
    formation_template: "",
    task: { id: "ComboTask", params: { tasks: {} } },
  };
}

/**
 * Every group needs a first route point, even one that never moves.
 *
 * The Mission Editor's `fixUnitsPos` reads `route.points[1]` unconditionally for
 * any group that has a `route`, so a group with an empty `points` table makes the
 * editor fail to open the whole mission with
 * `me_mission.lua: attempt to index field '?' (a nil value)`. No mission saved by
 * the editor has an empty route.
 */
function initialRoute(category: string, x: number, y: number, altitudeMetres?: number): LuaTable {
  const defaults = ROUTE_DEFAULTS[category] ?? ROUTE_DEFAULTS.vehicle;
  return {
    points: {
      1: routePoint({
        x,
        y,
        alt: altitudeMetres ?? defaults.alt,
        speed: defaults.speed,
        type: defaults.type,
        action: defaults.action,
        etaLocked: true,
      }),
    },
  };
}

/**
 * DCS stores unit headings in RADIANS, measured clockwise from north.
 *
 * The authoring API takes degrees because that is what a mission author thinks
 * in, so every heading is converted on the way out. Writing degrees straight
 * through is not a rounding error — a heading of 90 becomes 90 radians, which
 * wraps to roughly 117 degrees and points the unit somewhere arbitrary.
 */
export function headingRadians(degrees: number | undefined): number {
  const deg = ((degrees ?? 0) % 360 + 360) % 360;
  return (deg * Math.PI) / 180;
}

/**
 * Spacing between units in a group, per category, in metres. Ground spacing is
 * what the Mission Editor's own convoys use.
 */
export const FORMATION_SPACING: Record<string, number> = {
  plane: 60,
  helicopter: 60,
  vehicle: 20,
  // Was 120 m. In DCS 2.9.31 (2026-11-17) a Moskva with two Rezky escorts laid
  // out 120 m apart collided at t=0: both escorts HIT/KILLed each other and died.
  // ME-saved warship groups sampled are 863-1185 m apart (frigates, Arleigh
  // Burke, Forrestal); only speedboats/fast attack craft sit closer. There is no
  // per-hull length data, so one safe warship spacing is used.
  ship: 1000,
};

interface UnitSpec {
  /** One entry per unit, in the order they trail the lead. */
  types: string[];
  x: number;
  y: number;
  altitudeMetres?: number;
  /** Heading in DEGREES; converted to radians on the way into the mission. */
  heading?: number;
  skill?: string;
  /** Group category, which sets the spacing between units. */
  category: string;
  /** First `unitId` to assign; subsequent units increment from here. */
  firstUnitId: number;
  /** Override the per-category spacing (metres between units). */
  spacingMetres?: number;
  /** Explicit (forward, right) offsets from the lead, one per unit. */
  offsets?: { forward: number; right: number }[];
  /**
   * Each unit's own facing in DEGREES relative to the group heading, one per unit.
   *
   * A SAM site is not a formation of identically-aligned vehicles: the Mission
   * Editor's own SA-2 template points each of its six launchers outward along a
   * different bearing. Only a single-route-point group keeps these — with two or
   * more route points the editor recomputes every unit heading from the leg.
   */
  headingOffsetsDegrees?: number[];
}

/**
 * Lay a group's units out as a column trailing the group's heading.
 *
 * The offset MUST be derived from the heading. A fixed diagonal offset (the
 * previous `x + 30, y + 30`) strings every group out to the north-east no matter
 * which way it faces, which in the Mission Editor shows up as a group sitting at
 * a 45-degree angle to its own direction of travel.
 *
 * DCS map axes: `x` is north, `y` is east, so the forward vector for a heading is
 * `(cos h, sin h)` and units are placed behind the lead by subtracting it.
 */
function buildUnits(groupName: string, spec: UnitSpec): LuaTable {
  const heading = headingRadians(spec.heading);
  const spacing = spec.spacingMetres ?? FORMATION_SPACING[spec.category] ?? FORMATION_SPACING.vehicle;
  const forwardX = Math.cos(heading);
  const forwardY = Math.sin(heading);

  const units: LuaTable = {};
  // A group with no units is the one shape that looks fine in the file and does
  // nothing in the mission, and it used to be produced silently when a caller
  // passed a site template id straight to the authoring function instead of
  // resolving it to a composition first.
  if (!spec.types.length) {
    throw new Error(
      `Group '${groupName}' would have no units. Pass a type, a composition, or resolve a site ` +
        `template to a composition first (findSiteTemplate).`
    );
  }
  if (spec.offsets && spec.offsets.length !== spec.types.length) {
    throw new Error(`Group '${groupName}' has ${spec.types.length} unit(s) but ${spec.offsets.length} offset(s).`);
  }
  if (spec.headingOffsetsDegrees && spec.headingOffsetsDegrees.length !== spec.types.length) {
    throw new Error(
      `Group '${groupName}' has ${spec.types.length} unit(s) but ${spec.headingOffsetsDegrees.length} heading offset(s).`
    );
  }
  for (let i = 1; i <= spec.types.length; i++) {
    const back = (i - 1) * spacing;
    // Right of the heading is the forward vector turned 90 degrees clockwise:
    // (cos(h + 90), sin(h + 90)) = (-sin h, cos h).
    const off = spec.offsets?.[i - 1];
    const dx = off ? off.forward * forwardX - off.right * forwardY : -back * forwardX;
    const dy = off ? off.forward * forwardY + off.right * forwardX : -back * forwardY;
    const turn = spec.headingOffsetsDegrees?.[i - 1];
    const unit: LuaTable = {
      name: `${groupName}-${i}`,
      unitId: spec.firstUnitId + i - 1,
      type: spec.types[i - 1],
      x: spec.x + dx,
      y: spec.y + dy,
      heading: turn === undefined ? heading : headingRadians((spec.heading ?? 0) + turn),
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

/** One block of same-type units inside a mixed group. */
export interface UnitComposition {
  type: string;
  count: number;
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
  /**
   * Mixed unit types in ONE group, laid out in the order given.
   *
   * A working SAM site is not N copies of one vehicle: an SA-6 needs its
   * `1S91 str` search/track radar *and* `Kub 2P25 ln` launchers in the same
   * group, or the site registers with Skynet and then never shoots. When this
   * is given it replaces `type`/`count`.
   */
  composition?: UnitComposition[];
  /** Override the per-category unit spacing (metres). SAM sites want more room. */
  spacingMetres?: number;
  /** Aircraft only: where the group starts. Defaults to in the air at x/y. */
  start?: AircraftStart;
  /**
   * Explicit per-unit positions relative to the lead, in metres along the
   * heading (`forward`) and to its right (`right`). One per unit, lead first.
   * Overrides the default column — used for ship formations and for site
   * templates copied from the Mission Editor's own template library.
   */
  offsets?: { forward: number; right: number }[];
  /** Each unit's own facing in DEGREES relative to the group heading, one per unit. */
  headingOffsetsDegrees?: number[];
}

/** Expand `composition` (or the plain type/count pair) into one type per unit. */
function unitTypes(args: AddGroupArgs): string[] {
  if (!args.composition || args.composition.length === 0) {
    return Array.from({ length: args.count }, () => args.type);
  }
  const types: string[] = [];
  for (const block of args.composition) {
    for (let i = 0; i < block.count; i++) types.push(block.type);
  }
  if (types.length === 0) throw new Error(`Group '${args.name}' has a composition with no units.`);
  return types;
}

/**
 * Where an aircraft group starts.
 *
 * The point types and actions are the ones the Mission Editor writes (and pydcs
 * reproduces): `TakeOffParking` / "From Parking Area" for a cold start,
 * `TakeOffParkingHot` / "From Parking Area Hot" for hot, `TakeOff` / "From Runway".
 * A ship start is a parking start whose point carries `linkUnit` and `helipadId`
 * set to the ship unit's id instead of an `airdromeId`.
 */
export type AircraftStart =
  | { kind: "air" }
  | { kind: "runway"; airfield: string | number }
  | { kind: "parking_cold" | "parking_hot"; airfield: string | number; parking?: string[] }
  | { kind: "ship_cold" | "ship_hot"; ship: string }
  | { kind: "farp_cold" | "farp_hot"; farp: string };

const START_POINT: Record<Exclude<AircraftStart["kind"], "air">, { type: string; action: string }> = {
  runway: { type: "TakeOff", action: "From Runway" },
  parking_cold: { type: "TakeOffParking", action: "From Parking Area" },
  parking_hot: { type: "TakeOffParkingHot", action: "From Parking Area Hot" },
  ship_cold: { type: "TakeOffParking", action: "From Parking Area" },
  ship_hot: { type: "TakeOffParkingHot", action: "From Parking Area Hot" },
  farp_cold: { type: "TakeOffParking", action: "From Parking Area" },
  farp_hot: { type: "TakeOffParkingHot", action: "From Parking Area Hot" },
};

/**
 * Parking slots at an airfield already taken in this mission — by a flight that
 * starts there (its units carry `parking_id`), or by a static object standing on
 * the slot. Both directions matter: a flight spawned onto a slot with a parked
 * static aircraft on it collides with it at mission start.
 */
export function occupiedParking(mission: LuaTable, airport: Airport): Set<string> {
  const taken = new Set<string>();
  const statics: { x: number; y: number }[] = [];
  eachGroup(mission, (group, category) => {
    if (category === "static") {
      for (const unit of luaArray(group["units"])) statics.push({ x: Number(unit["x"]), y: Number(unit["y"]) });
      return;
    }
    const first = asTable(asTable(asTable(group["route"])?.["points"])?.[1]);
    if (first?.["airdromeId"] !== airport.id) return;
    for (const unit of luaArray(group["units"])) {
      if (unit["parking_id"] !== undefined) taken.add(String(unit["parking_id"]));
    }
  });
  for (const slot of airport.slots) {
    const reach = Math.max(4, slot[5] / 2);
    if (statics.some((p) => Math.hypot(p.x - slot[2], p.y - slot[3]) < reach)) taken.add(slot[1]);
  }
  return taken;
}

/**
 * Choose parking slots the aircraft physically fits, the way pydcs does for the
 * current (v2) slot data: width, length and height must all fit, and the slot
 * must allow the category (helicopter vs aeroplane). Slots are taken in slot-name
 * order, so a flight parks together.
 */
export function chooseParking(
  airport: Airport,
  category: AirCategory,
  type: string,
  count: number,
  taken: Set<string>,
  requested?: string[]
): Airport["slots"] {
  const dims = findUnitType(type)?.entry as FlyingType | undefined;
  const flag = category === "helicopter" ? SLOT_HELI : SLOT_AIRPLANES;
  // A slot sampled from a running DCS (an airbase pack, the only source for a theatre
  // pydcs never exported) carries no flags and no dimensions: `world.getAirbases()` does
  // not report them. Zeroes therefore mean UNKNOWN, and an unknown slot is accepted
  // rather than failed against invented dimensions — the editor and the sim decide.
  const unknownSlot = (s: Airport["slots"][number]) => s[4] === 0 && s[5] === 0 && s[6] === 0;
  const fitsSlot = (s: Airport["slots"][number]) => unknownSlot(s) || ((s[4] & flag) !== 0 &&
    (!dims || ((dims.width === null || dims.width < s[5]) &&
    (dims.length === null || dims.length < s[6]) && (dims.height === null || dims.height < (s[7] || 1000)))));
  if (requested && requested.length) {
    if (new Set(requested).size !== requested.length) throw new Error("Duplicate requested parking slots");
    if (requested.length !== count) {
      throw new Error(`parking lists ${requested.length} slot(s) for a group of ${count} aircraft.`);
    }
    return requested.map((name) => {
      const slot = airport.slots.find((s) => s[1] === name);
      if (!slot) throw new Error(`No parking slot '${name}' at ${airport.name}. Use dcs_list_airfields to see them.`);
      if (taken.has(name)) throw new Error(`Parking slot '${name}' at ${airport.name} is already used.`);
      if (!fitsSlot(slot)) throw new Error(`Parking slot '${name}' at ${airport.name} does not fit ${type} (${category}).`);
      return slot;
    });
  }
  const fits = airport.slots
    .filter((s) => !taken.has(s[1]) && fitsSlot(s))
    .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
  if (fits.length < count) {
    throw new Error(
      `${airport.name} has ${fits.length} free parking slot(s) that fit a ${type}; ${count} needed. ` +
        `Use fewer aircraft, another airfield, or a runway start.`
    );
  }
  return fits.slice(0, count);
}

/**
 * A starting payload: full internal fuel and the type's countermeasures, from
 * the unit catalogue. A unit with no payload table at all gives the editor and
 * the sim nothing to work with; the editor itself always writes one.
 */
export function defaultPayload(type: string): LuaTable | undefined {
  const entry = findUnitType(type)?.entry as FlyingType | undefined;
  if (!entry || entry.fuelMax === null || entry.fuelMax === undefined) return undefined;
  return {
    pylons: {},
    // Same string form setPayload writes; that is what the flown e2e mission used.
    fuel: String(entry.fuelMax),
    flare: entry.flare ?? 0,
    chaff: entry.chaff ?? 0,
    gun: 100,
  };
}

/** Add a fixed-wing or helicopter group. Returns the created group table. */
export function addAircraftGroup(mission: LuaTable, category: AirCategory, args: AddGroupArgs): LuaTable {
  const start = args.start ?? { kind: "air" };
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 16) throw new Error("Aircraft count must be 1..16");
  const ids = maxIds(mission);
  const types = unitTypes(args);
  assertNamesFree(mission, args.name, types.map((_, i) => `${args.name}-${i + 1}`));

  let units: LuaTable;
  let route: LuaTable;
  if (start.kind === "air") {
    units = buildUnits(args.name, {
      types,
      x: args.x,
      y: args.y,
      altitudeMetres: args.altitudeMetres ?? 6096,
      heading: args.heading,
      skill: args.skill,
      category,
      firstUnitId: ids.unitId + 1,
      spacingMetres: args.spacingMetres,
    });
    route = initialRoute(category, args.x, args.y, args.altitudeMetres ?? 6096);
  } else {
    const point = START_POINT[start.kind];
    const placements: { x: number; y: number; parking?: number; parkingId?: string }[] = [];
    const extra: LuaTable = {};
    if ("farp" in start) {
      if (category !== "helicopter") throw new Error("FARP starts require helicopters");
      // pydcs `flight_group_from_unit`: link to the pad's unit id and park the
      // flight in a 10 m rectangle beside it; DCS assigns the actual pads.
      const pad = findUnit(mission, start.farp) ?? luaArray(findGroup(mission, start.farp)?.group["units"])[0];
      if (!pad || typeof pad["unitId"] !== "number" || pad["category"] !== "Heliports") {
        throw new Error(`No FARP or helipad named '${start.farp}' in this mission; add one with dcs_miz_add_farp.`);
      }
      const capacity = pad.type === "FARP" ? 4 : 1;
      if (linkedAircraftCount(mission, Number(pad.unitId)) + types.length > capacity) throw new Error(`FARP '${start.farp}' has insufficient pads (${capacity})`);
      const h = Number(pad["heading"] ?? 0);
      for (let i = 0; i < types.length; i++) {
        const fwd = Math.floor(i / 2) * 10;
        const right = (i % 2) * 10;
        placements.push({
          x: Number(pad["x"]) - fwd * Math.cos(h) - right * Math.sin(h),
          y: Number(pad["y"]) - fwd * Math.sin(h) + right * Math.cos(h),
        });
      }
      extra["linkUnit"] = pad["unitId"];
      extra["helipadId"] = pad["unitId"];
    } else if ("ship" in start) {
      const ship = findUnit(mission, start.ship);
      if (!ship || typeof ship["unitId"] !== "number") {
        throw new Error(`No ship unit named '${start.ship}' in this mission; add the ship first.`);
      }
      const shipGroup = findGroupOfUnit(mission, start.ship);
      if (shipGroup?.category !== "ship") throw new Error(`Unit '${start.ship}' is not a ship.`);
      const capacity = authoringData().ships[String(ship.type)]?.parking;
      if (capacity !== undefined && capacity < 1)
        throw new Error(`Ship '${start.ship}' has no aircraft parking in the reference`);
      for (let i = 0; i < types.length; i++) {
        placements.push({ x: Number(ship["x"]), y: Number(ship["y"]) });
      }
      extra["linkUnit"] = ship["unitId"];
      extra["helipadId"] = ship["unitId"];
    } else {
      const theatreName = resolveTheatreName(String(mission["theatre"] ?? ""));
      if (!theatreName) {
        throw new Error(
          `Airfield starts need a known theatre; this mission's is '${String(mission["theatre"])}'.`
        );
      }
      const airfieldStart = start as Extract<AircraftStart, { airfield: string | number }>;
      const airport = findAirport(theatreName, airfieldStart.airfield);
      extra["airdromeId"] = airport.id;
      if (airfieldStart.kind === "runway") {
        for (let i = 0; i < types.length; i++) placements.push({ x: airport.x, y: airport.y });
      } else {
        const slots = chooseParking(
          airport,
          category,
          types[0],
          types.length,
          occupiedParking(mission, airport),
          "parking" in airfieldStart ? airfieldStart.parking : undefined
        );
        for (const slot of slots) placements.push({ x: slot[2], y: slot[3], parking: slot[0], parkingId: slot[1] });
      }
    }

    units = {};
    placements.forEach((p, i) => {
      const unit: LuaTable = {
        name: `${args.name}-${i + 1}`,
        unitId: ids.unitId + 1 + i,
        type: types[i],
        x: p.x,
        y: p.y,
        alt: 0,
        alt_type: "BARO",
        heading: headingRadians(args.heading),
        skill: args.skill ?? "High",
        speed: 0,
      };
      if (p.parking !== undefined) {
        unit["parking"] = p.parking;
        unit["parking_id"] = p.parkingId as string;
      }
      units[i + 1] = unit;
    });
    const first = placements[0];
    const routePt = routePoint({
      x: first.x,
      y: first.y,
      alt: 0,
      speed: 0,
      type: point.type,
      action: point.action,
      etaLocked: true,
    });
    Object.assign(routePt, extra);
    route = { points: { 1: routePt } };
  }

  for (const unit of luaArray(units)) {
    const payload = defaultPayload(String(unit["type"]));
    if (payload) unit["payload"] = payload;
  }

  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const catTable = (country[category] ??= { group: {} }) as LuaTable;
  const groups = (catTable["group"] ??= {}) as LuaTable;
  const firstUnit = asTable(units[1]);
  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    task: args.task ?? "CAP",
    task_started: false,
    // Seconds after mission start. Every ME-saved plane/helicopter/vehicle/ship
    // group carries it (0 unless delayed); the ME's auto-briefing does
    // `mission.start_time + group.start_time` and errors on Fly without it.
    start_time: 0,
    units,
    route,
    x: Number(firstUnit?.["x"] ?? args.x),
    y: Number(firstUnit?.["y"] ?? args.y),
  };
  applyEditorAircraftDefaults(group, String(country["name"] ?? args.country ?? ""));
  groups[nextIndex(groups)] = group;
  return group;
}

/**
 * Countries whose ME-saved aircraft carry a NUMERIC callsign (100, 101, ...)
 * rather than a {family, flight, element, name} table. Observed, not inferred:
 * 203 units across Russia, Ukraine and USSR in the sampled ME-saved missions,
 * versus 802 table callsigns across 27 other countries.
 */
const NUMERIC_CALLSIGN_COUNTRIES = new Set(["Russia", "Ukraine", "USSR"]);

/**
 * Fields the Mission Editor writes on every plane/helicopter group and unit
 * (124/124 player units sampled) that the flight builders did not. Verified in
 * DCS 2.9.31 on 2026-11-16: with them (plus the mission-level picture/neutral
 * task fields) a player slot gets a working briefing and Fly; without them the
 * briefing fails and no player aircraft exists. Existing values are never
 * overwritten, so configure_flight callsigns/liveries/tail numbers still win.
 */
export function applyEditorAircraftDefaults(group: LuaTable, countryName: string): void {
  const defaults: LuaTable = { modulation: 0, tasks: {}, radioSet: false, uncontrolled: false, hidden: false, uncontrollable: false };
  for (const [key, value] of Object.entries(defaults)) if (group[key] === undefined) group[key] = value;
  const numeric = NUMERIC_CALLSIGN_COUNTRIES.has(countryName);
  const units = luaArray(group["units"]);
  // Family 1 of the role's list: Enfield (aircraft), Overlord (AWACS), Texaco (tanker).
  const family = numeric ? "" : String(callsignOptions(String(units[0]?.["type"] ?? ""), String(group["task"] ?? "")).families[1] ?? "Enfield").replace(/\s+/g, "");
  units.forEach((unit, i) => {
    if (unit["callsign"] === undefined) {
      unit["callsign"] = numeric ? 100 + i : { 1: 1, 2: 1, 3: i + 1, name: `${family}1${i + 1}` };
    }
    if (unit["onboard_num"] === undefined) unit["onboard_num"] = String(Number(unit["unitId"] ?? i + 1) % 1000).padStart(3, "0");
    if (unit["livery_id"] === undefined) unit["livery_id"] = "";
    if (unit["psi"] === undefined) unit["psi"] = -Number(unit["heading"] ?? 0);
  });
}

/** Add a ground-vehicle or ship group. Returns the created group table. */
export function addGroundGroup(mission: LuaTable, category: GroundCategory, args: AddGroupArgs): LuaTable {
  // Check names before ensureCountry so a refusal leaves the mission untouched.
  assertNamesFree(mission, args.name, unitTypes(args).map((_, i) => `${args.name}-${i + 1}`));
  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const catTable = (country[category] ??= { group: {} }) as LuaTable;
  const groups = (catTable["group"] ??= {}) as LuaTable;
  const ids = maxIds(mission);

  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    task: args.task ?? "Ground Nothing",
    start_time: 0, // see addAircraftGroup
    units: buildUnits(args.name, {
      types: unitTypes(args),
      x: args.x,
      y: args.y,
      heading: args.heading,
      skill: args.skill ?? "Average",
      category,
      firstUnitId: ids.unitId + 1,
      spacingMetres: args.spacingMetres,
      offsets: args.offsets,
      headingOffsetsDegrees: args.headingOffsetsDegrees,
    }),
    route: initialRoute(category, args.x, args.y),
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

/**
 * Highest `zoneId` already used. Trigger zones are referenced from compiled
 * triggers by this id, not by their array position, so it must stay unique.
 */
export function maxZoneId(mission: LuaTable): number {
  let max = 0;
  for (const zone of luaArray(asTable(mission["triggers"])?.["zones"])) {
    const id = zone["zoneId"];
    if (typeof id === "number" && id > max) max = id;
  }
  return max;
}

/** Add a circular trigger zone. */
export function addTriggerZone(mission: LuaTable, args: AddZoneArgs): LuaTable {
  const triggers = (mission["triggers"] ??= { zones: {} }) as LuaTable;
  const zones = (triggers["zones"] ??= {}) as LuaTable;
  // Triggers resolve zones by name; a duplicate would make that lookup ambiguous.
  if (luaArray(zones).some((z) => z["name"] === args.name)) throw new Error(`A trigger zone named '${args.name}' already exists`);
  const zone: LuaTable = {
    name: args.name,
    zoneId: maxZoneId(mission) + 1,
    x: args.x,
    y: args.y,
    radius: args.radius,
    hidden: false,
    heading: 0,
    type: 0,
    properties: {},
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

/** Refuse a group/unit name already used anywhere in the mission (groups and statics alike). */
export function assertNamesFree(mission: LuaTable, groupName: string | undefined, unitNames: string[] = []): void {
  if (groupName !== undefined && findGroup(mission, groupName)) throw new Error(`Group '${groupName}' already exists`);
  const seen = new Set<string>();
  for (const name of unitNames) {
    if (seen.has(name)) throw new Error(`Unit name '${name}' is used twice in the same request`);
    seen.add(name);
    if (findUnit(mission, name)) throw new Error(`A unit named '${name}' already exists`);
  }
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

/** Visit every group in the mission. */
export function eachGroup(
  mission: LuaTable,
  visit: (group: LuaTable, category: string, side: Side, country: LuaTable) => void
): void {
  const coalitions = asTable(mission["coalition"]);
  for (const side of ["red", "blue", "neutrals"] as Side[]) {
    const sideTable = asTable(coalitions?.[side]);
    for (const country of luaArray(sideTable?.["country"])) {
      for (const category of ALL_CATEGORIES) {
        const catTable = asTable(country[category]);
        for (const group of luaArray(catTable?.["group"])) visit(group, category, side, country);
      }
    }
  }
}

/** The group a named unit belongs to. */
export function findGroupOfUnit(mission: LuaTable, unitName: string): FoundGroup | undefined {
  let hit: FoundGroup | undefined;
  eachGroup(mission, (group, category, side, country) => {
    if (hit) return;
    if (luaArray(group["units"]).some((u) => u["name"] === unitName)) hit = { group, category, side, country };
  });
  return hit;
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
  const defaults = ROUTE_DEFAULTS[found.category] ?? ROUTE_DEFAULTS.vehicle;
  const route = (found.group["route"] ??= { points: {} }) as LuaTable;
  const points = (route["points"] ??= {}) as LuaTable;
  const index = nextIndex(points);
  const point = routePoint({
    x: wp.x,
    y: wp.y,
    alt: wp.altitudeMetres ?? defaults.alt,
    speed: wp.speedMps ?? defaults.speed,
    type: wp.type ?? defaults.type,
    action: wp.action ?? defaults.action,
    name: wp.name,
    // Only the mission-start point is ETA-locked; appended waypoints never are.
    etaLocked: index === 1,
  });
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
  validatePayload(unit, args);
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

// ---------------------------------------------------------------------------
// Triggers
//
// A DCS mission stores triggers twice. `mission.trigrules` is the structured
// form the Mission Editor reads and edits; `mission.trig` holds the compiled Lua
// the simulation actually runs. The ME regenerates `trig` on every save, so a
// mission that only has `trigrules` looks correct in the editor but does nothing
// when flown. We therefore emit both.
//
// Every predicate signature below was captured from Mission-Editor-saved `.miz`
// files, not inferred: see `tests/fixtures/trig-oracle.json` for the recorded
// spec -> compiled-Lua pairs that the tests assert against.
// ---------------------------------------------------------------------------

export type TriggerType = "start" | "once" | "continuous" | "change";

/** Unit-category filter used by the coalition-in-zone conditions. */
export type UnitTypeFilter = "ALL" | "AIRPLANE" | "HELICOPTER" | "GROUND_UNIT" | "SHIP";

export type ConditionSpec =
  | { kind: "time_after"; seconds: number }
  | { kind: "time_since_flag"; flag: number; seconds: number }
  | { kind: "flag_is_true"; flag: number }
  | { kind: "flag_is_false"; flag: number }
  | { kind: "flag_equals"; flag: number; value: number }
  | { kind: "flag_more"; flag: number; value: number }
  | { kind: "unit_in_zone"; unit: string; zone: string }
  | { kind: "unit_out_zone"; unit: string; zone: string }
  | { kind: "unit_dead"; unit: string }
  | { kind: "group_dead"; group: string }
  | { kind: "group_life_less"; group: string; percent: number }
  | { kind: "part_of_group_in_zone"; group: string; zone: string }
  | { kind: "part_of_coalition_in_zone"; coalition: Side; zone: string; unitType?: UnitTypeFilter }
  | { kind: "random_less"; percent: number }
  // --- captured in the 2026-11-17 sweep of Mission-Editor-saved missions -----
  | { kind: "group_alive"; group: string }
  | { kind: "unit_damaged"; unit: string }
  | { kind: "all_of_group_in_zone"; group: string; zone: string }
  | { kind: "part_of_group_out_zone"; group: string; zone: string }
  // The editor's moving zone: `zone` gives the size, `zoneUnit` carries it.
  | { kind: "unit_in_zone_unit"; unit: string; zone: string; zoneUnit: string }
  | { kind: "unit_altitude_higher"; unit: string; altitudeMetres: number }
  | { kind: "unit_altitude_higher_agl"; unit: string; altitudeMetres: number }
  | { kind: "unit_altitude_lower"; unit: string; altitudeMetres: number }
  // `types` is the editor's own four-number weapon selector, which this server
  // does not interpret: copy it from a mission that already does what you want.
  | { kind: "missile_in_zone"; zone: string; types: number[]; count?: number }
  | { kind: "bomb_in_zone"; zone: string; types: number[]; count?: number }
  // Not a test: a separator that makes the compiled chunk join with ` or `
  // instead of ` and `, exactly as the editor's OR condition group does.
  | { kind: "or" };

export type ActionSpec =
  | { kind: "message"; text: string; seconds?: number; clearview?: boolean; delaySeconds?: number }
  | {
      kind: "message_to_coalition";
      coalition: Side;
      text: string;
      seconds?: number;
      clearview?: boolean;
      delaySeconds?: number;
    }
  // The per-group message has no delay parameter in DCS.
  | { kind: "message_to_group"; group: string; text: string; seconds?: number; clearview?: boolean; delaySeconds?: number }
  | { kind: "set_flag"; flag: number; value?: number }
  | { kind: "clear_flag"; flag: number }
  | { kind: "activate_group"; group: string }
  | { kind: "deactivate_group"; group: string }
  | { kind: "group_on"; group: string }
  | { kind: "group_off"; group: string }
  | { kind: "message_to_unit"; unit: string; text: string; seconds?: number; clearview?: boolean; delaySeconds?: number }
  | { kind: "message_to_country"; countryId: number; text: string; seconds?: number; clearview?: boolean; delaySeconds?: number }
  | { kind: "explode"; zone: string; power?: number; altitudeMetres?: number }
  | { kind: "smoke"; zone: string; preset?: number; density?: number }
  | { kind: "signal_flare"; zone: string; color?: number; altitudeMetres?: number; bearing?: number }
  | { kind: "set_flag_random"; flag: number; min: number; max: number }
  | { kind: "group_resume"; group: string }
  | { kind: "end_mission"; winner: Side; delaySeconds?: number }
  // --- radio menu (F10 "Other") ---
  // An item sets `flag` to `value` when the player picks it; pair it with a
  // `flag_is_true`/`flag_equals` condition on another trigger to react.
  | { kind: "add_radio_item"; text: string; flag: number; value?: number }
  | { kind: "add_radio_item_for_group"; group: string; text: string; flag: number; value?: number }
  | { kind: "remove_radio_item"; text: string }
  | { kind: "remove_radio_item_for_group"; group: string; text: string }
  // --- resources: `resourceKey` comes from addResource() ---
  | { kind: "sound"; resourceKey: string; delaySeconds?: number }
  // The Mission Editor's START WAIT FOR USER action: holds the trigger until a
  // player raises `flag`, which is what a radio menu item does when picked.
  | { kind: "wait_for_user_flag"; flag: number; flagBack?: number }
  | { kind: "sound_to_coalition"; coalition: Side; resourceKey: string; delaySeconds?: number }
  | { kind: "sound_to_unit"; unit: string; resourceKey: string; delaySeconds?: number }
  | { kind: "sound_to_group"; group: string; resourceKey: string; delaySeconds?: number }
  | { kind: "stop_sound" }
  | {
      kind: "radio_transmission";
      resourceKey: string;
      zone: string;
      frequencyMHz: number;
      name: string;
      power?: number;
      modulationAM?: boolean;
      loop?: boolean;
      delaySeconds?: number;
      micEffects?: boolean;
      squelchEffects?: boolean;
    }
  // --- scripting ---
  | { kind: "do_script"; text: string }
  | { kind: "do_script_file"; resourceKey: string }
  // --- captured in the 2026-11-17 sweep of Mission-Editor-saved missions -----
  | { kind: "explode_unit"; unit: string; power?: number }
  | { kind: "smoke_marker"; zone: string; color?: number; altitudeMetres?: number }
  | { kind: "smoke_marker_unit"; unit: string; color?: number; name?: string }
  | { kind: "signal_flare_unit"; unit: string; color?: number; bearing?: number }
  | {
      kind: "picture_to_coalition";
      coalition: Side;
      resourceKey: string;
      seconds?: number;
      clearview?: boolean;
      delaySeconds?: number;
      size?: number;
      horizontalAlignment?: number;
      verticalAlignment?: number;
      sizeUnits?: number;
    }
  | { kind: "mark_to_all"; id: number; text: string; zone: string; readonly?: boolean; comment?: string }
  | { kind: "add_radio_item_for_coalition"; coalition: Side; text: string; flag: number; value?: number }
  | { kind: "set_atc_silent_mode"; airdromeId: number; silent?: boolean }
  | { kind: "shelling_zone"; zone: string; tnt: number; shells: number }
  | { kind: "resize_zone"; zone: string; metres: number }
  // Runs the group's n-th stored trigger task (the editor's "AI TASK PUSH"
  // list on the group, not a route waypoint task).
  | { kind: "ai_task"; group: string; taskNumber: number };

const TRIGGER_PREDICATE: Record<TriggerType, string> = {
  start: "triggerStart",
  once: "triggerOnce",
  continuous: "triggerContinious", // DCS spells it this way in the file format
  change: "triggerFront", // fires on each false -> true transition
};

/** DCS `coalition.side` enum names, as used by `a_end_mission`. */
const COALITION_SIDE: Record<Side, string> = {
  red: "coalition.side.RED",
  blue: "coalition.side.BLUE",
  neutrals: "coalition.side.NEUTRAL",
};

// --- id resolution ---------------------------------------------------------
//
// The Mission Editor stores numeric ids in triggers, never names. Resolving at
// authoring time means a typo fails loudly here instead of producing a trigger
// that DCS silently never fires.

function resolveGroupId(mission: LuaTable, name: string): number {
  const found = findGroup(mission, name);
  if (!found) throw new Error(`No group named '${name}' in this mission`);
  const id = found.group["groupId"];
  if (typeof id !== "number") throw new Error(`Group '${name}' has no numeric groupId`);
  return id;
}

function resolveUnitId(mission: LuaTable, name: string): number {
  const unit = findUnit(mission, name);
  if (!unit) throw new Error(`No unit named '${name}' in this mission`);
  const id = unit["unitId"];
  if (typeof id !== "number") throw new Error(`Unit '${name}' has no numeric unitId`);
  return id;
}

function resolveZoneId(mission: LuaTable, name: string): number {
  for (const zone of luaArray(asTable(mission["triggers"])?.["zones"])) {
    if (zone["name"] !== name) continue;
    const id = zone["zoneId"];
    if (typeof id !== "number") throw new Error(`Trigger zone '${name}' has no numeric zoneId`);
    return id;
  }
  throw new Error(`No trigger zone named '${name}' in this mission`);
}

// --- structured rule builders ---------------------------------------------

function conditionRule(mission: LuaTable, c: ConditionSpec): LuaTable {
  switch (c.kind) {
    case "time_after":
      return { predicate: "c_time_after", seconds: c.seconds };
    case "time_since_flag":
      return { predicate: "c_time_since_flag", flag: c.flag, seconds: c.seconds };
    case "flag_is_true":
      return { predicate: "c_flag_is_true", flag: c.flag };
    case "flag_is_false":
      return { predicate: "c_flag_is_false", flag: c.flag };
    case "flag_equals":
      return { predicate: "c_flag_equals", flag: c.flag, value: c.value };
    case "flag_more":
      return { predicate: "c_flag_more", flag: c.flag, value: c.value };
    case "unit_in_zone":
      return {
        predicate: "c_unit_in_zone",
        unit: resolveUnitId(mission, c.unit),
        zone: resolveZoneId(mission, c.zone),
      };
    case "unit_out_zone":
      return {
        predicate: "c_unit_out_zone",
        unit: resolveUnitId(mission, c.unit),
        zone: resolveZoneId(mission, c.zone),
      };
    case "unit_dead":
      return { predicate: "c_unit_dead", unit: resolveUnitId(mission, c.unit) };
    case "group_dead":
      return { predicate: "c_group_dead", group: resolveGroupId(mission, c.group) };
    case "group_life_less":
      return {
        predicate: "c_group_life_less",
        group: resolveGroupId(mission, c.group),
        percent: c.percent,
      };
    case "part_of_group_in_zone":
      return {
        predicate: "c_part_of_group_in_zone",
        group: resolveGroupId(mission, c.group),
        zone: resolveZoneId(mission, c.zone),
      };
    case "part_of_coalition_in_zone":
      return {
        predicate: "c_part_of_coalition_in_zone",
        coalitionlist: c.coalition,
        zone: resolveZoneId(mission, c.zone),
        unitType: c.unitType ?? "ALL",
      };
    case "random_less":
      return { predicate: "c_random_less", percent: c.percent };
    case "group_alive":
      return { predicate: "c_group_alive", group: resolveGroupId(mission, c.group) };
    case "unit_damaged":
      return { predicate: "c_unit_damaged", unit: resolveUnitId(mission, c.unit) };
    case "all_of_group_in_zone":
      return {
        predicate: "c_all_of_group_in_zone",
        group: resolveGroupId(mission, c.group),
        zone: resolveZoneId(mission, c.zone),
      };
    case "part_of_group_out_zone":
      return {
        predicate: "c_part_of_group_out_zone",
        group: resolveGroupId(mission, c.group),
        zone: resolveZoneId(mission, c.zone),
      };
    case "unit_in_zone_unit":
      return {
        predicate: "c_unit_in_zone_unit",
        unit: resolveUnitId(mission, c.unit),
        zone: resolveZoneId(mission, c.zone),
        zoneunit: resolveUnitId(mission, c.zoneUnit),
      };
    case "unit_altitude_higher":
      return {
        predicate: "c_unit_altitude_higher",
        unit: resolveUnitId(mission, c.unit),
        altitude: c.altitudeMetres,
      };
    case "unit_altitude_higher_agl":
      return {
        predicate: "c_unit_altitude_higher_AGL",
        unit: resolveUnitId(mission, c.unit),
        altitude: c.altitudeMetres,
      };
    case "unit_altitude_lower":
      return {
        predicate: "c_unit_altitude_lower",
        unit: resolveUnitId(mission, c.unit),
        altitude: c.altitudeMetres,
      };
    case "missile_in_zone":
      return {
        predicate: "c_missile_in_zone",
        typemissile: weaponSelector(c.types, "missile_in_zone"),
        nummissiles: c.count ?? 1,
        zone: resolveZoneId(mission, c.zone),
      };
    case "bomb_in_zone":
      return {
        predicate: "c_bomb_in_zone",
        typebomb: weaponSelector(c.types, "bomb_in_zone"),
        numbombs: c.count ?? 1,
        zone: resolveZoneId(mission, c.zone),
      };
    case "or":
      return { predicate: "or" };
  }
}

/**
 * The editor's weapon selector for `c_missile_in_zone` / `c_bomb_in_zone`: four
 * numbers it joins with dots in the compiled call (`"4.4.11.125"`). What the
 * numbers MEAN is not documented anywhere this project can read, so they are
 * passed through unchanged and never generated: copy them from a mission whose
 * condition already selects the weapons you want.
 */
function weaponSelector(types: number[], kind: string): LuaTable {
  if (types.length !== 4 || types.some((t) => !Number.isInteger(t) || t < 0)) {
    throw new Error(
      `${kind} needs exactly four non-negative integers (the editor's own weapon selector, ` +
        `e.g. [4, 4, 11, 125] copied from an existing mission); got ${JSON.stringify(types)}.`
    );
  }
  const out: LuaTable = {};
  types.forEach((t, i) => { out[i + 1] = t; });
  return out;
}

/**
 * Message text lives in `l10n/DEFAULT/dictionary` behind a `DictKey_...`, exactly
 * as the Mission Editor writes it. `maxDictId` is one shared counter across every
 * DictKey prefix in the mission, so allocation just increments it.
 */
function allocateDictKey(
  mission: LuaTable,
  dictionary: LuaTable,
  text: string,
  prefix = "DictKey_ActionText_"
): string {
  const key = `${prefix}${nextDictId(mission)}`;
  dictionary[key] = text;
  return key;
}

/**
 * Resolve message text to what goes in the action's `text` field: a dictionary
 * key when a dictionary is available, otherwise the literal string. Both forms
 * compile to a valid call because `getValueDictByKey` just returns a string.
 */
function messageText(mission: LuaTable, dictionary: LuaTable | undefined, text: string): string {
  return dictionary ? allocateDictKey(mission, dictionary, text) : text;
}

/** Radio menu labels use their own DictKey prefix and their own spec fields. */
function radioText(mission: LuaTable, dictionary: LuaTable | undefined, text: string): LuaTable {
  const key = dictionary
    ? allocateDictKey(mission, dictionary, text, "DictKey_ActionRadioText_")
    : text;
  return { radiotext: key, KeyDict_radiotext: key };
}

/** The five text-message actions share this shape; only the audience differs. */
function textFields(
  mission: LuaTable,
  dictionary: LuaTable | undefined,
  a: { text: string; seconds?: number; clearview?: boolean; delaySeconds?: number }
): LuaTable {
  const key = messageText(mission, dictionary, a.text);
  return {
    text: key,
    KeyDict_text: key,
    seconds: a.seconds ?? 10,
    clearview: a.clearview ?? false,
    start_delay: a.delaySeconds ?? 0,
  };
}

function actionRule(mission: LuaTable, a: ActionSpec, dictionary?: LuaTable): LuaTable {
  switch (a.kind) {
    case "message": {
      const key = messageText(mission, dictionary, a.text);
      return {
        predicate: "a_out_text_delay",
        text: key,
        KeyDict_text: key,
        seconds: a.seconds ?? 10,
        clearview: a.clearview ?? false,
        start_delay: a.delaySeconds ?? 0,
      };
    }
    case "message_to_coalition": {
      const key = messageText(mission, dictionary, a.text);
      return {
        predicate: "a_out_text_delay_s",
        coalitionlist: a.coalition,
        text: key,
        KeyDict_text: key,
        seconds: a.seconds ?? 10,
        clearview: a.clearview ?? false,
        start_delay: a.delaySeconds ?? 0,
      };
    }
    case "message_to_group": {
      const key = messageText(mission, dictionary, a.text);
      return {
        predicate: "a_out_text_delay_g",
        group: resolveGroupId(mission, a.group),
        text: key,
        KeyDict_text: key,
        seconds: a.seconds ?? 10,
        clearview: a.clearview ?? false,
        // Omitted entirely when no delay is asked for, so the call compiles to
        // the editor's four-argument form.
        ...(a.delaySeconds === undefined ? {} : { start_delay: a.delaySeconds }),
      };
    }
    case "set_flag":
      // The ME has two actions here: a plain "set flag on", and "set flag value".
      return a.value === undefined
        ? { predicate: "a_set_flag", flag: a.flag }
        : { predicate: "a_set_flag_value", flag: a.flag, value: a.value };
    case "clear_flag":
      return { predicate: "a_clear_flag", flag: a.flag };
    case "activate_group":
      return { predicate: "a_activate_group", group: resolveGroupId(mission, a.group) };
    case "deactivate_group":
      return { predicate: "a_deactivate_group", group: resolveGroupId(mission, a.group) };
    case "group_on":
      return { predicate: "a_group_on", group: resolveGroupId(mission, a.group) };
    case "group_off":
      return { predicate: "a_group_off", group: resolveGroupId(mission, a.group) };
    case "explode":
      return {
        predicate: "a_explosion",
        zone: resolveZoneId(mission, a.zone),
        altitude: a.altitudeMetres ?? 1,
        volume: a.power ?? 100,
      };
    case "smoke":
      return {
        predicate: "a_effect_smoke",
        zone: resolveZoneId(mission, a.zone),
        preset: a.preset ?? 1,
        density: a.density ?? 1,
        name: "",
      };
    case "signal_flare":
      return {
        predicate: "a_signal_flare",
        zone: resolveZoneId(mission, a.zone),
        altitude: a.altitudeMetres ?? 1,
        // DCS stores flare colour and bearing as strings, not numbers.
        color: String(a.color ?? 1),
        bearing: a.bearing ?? 0,
      };
    case "message_to_unit":
      return {
        predicate: "a_out_text_delay_u",
        unit: resolveUnitId(mission, a.unit),
        ...textFields(mission, dictionary, a),
      };
    case "message_to_country":
      return {
        predicate: "a_out_text_delay_c",
        countrylist: a.countryId,
        ...textFields(mission, dictionary, a),
      };
    case "set_flag_random":
      return { predicate: "a_set_flag_random", flag: a.flag, min_value: a.min, max_value: a.max };
    case "group_resume":
      return { predicate: "a_group_resume", group: resolveGroupId(mission, a.group) };
    case "end_mission":
      return {
        predicate: "a_end_mission",
        winner: COALITION_SIDE[a.winner],
        text: "",
        KeyDict_text: "",
        start_delay: a.delaySeconds ?? 0,
      };

    // --- radio menu ---
    case "add_radio_item":
      return {
        predicate: "a_add_radio_item",
        ...radioText(mission, dictionary, a.text),
        flag: a.flag,
        value: a.value ?? 1,
      };
    case "add_radio_item_for_group":
      return {
        predicate: "a_add_radio_item_for_group",
        group: resolveGroupId(mission, a.group),
        ...radioText(mission, dictionary, a.text),
        flag: a.flag,
        value: a.value ?? 1,
      };
    case "remove_radio_item":
      return { predicate: "a_remove_radio_item", ...radioText(mission, dictionary, a.text) };
    case "remove_radio_item_for_group":
      return {
        predicate: "a_remove_radio_item_for_group",
        group: resolveGroupId(mission, a.group),
        ...radioText(mission, dictionary, a.text),
      };

    // --- sound and radio ---
    case "sound":
      return { predicate: "a_out_sound", file: a.resourceKey, start_delay: a.delaySeconds ?? 0 };
    case "sound_to_coalition":
      return {
        predicate: "a_out_sound_s",
        coalitionlist: a.coalition,
        file: a.resourceKey,
        start_delay: a.delaySeconds ?? 0,
      };
    case "sound_to_unit":
      return { predicate: "a_out_sound_u", unit: resolveUnitId(mission, a.unit), file: a.resourceKey, start_delay: a.delaySeconds ?? 0 };
    case "sound_to_group":
      return {
        predicate: "a_out_sound_g",
        group: resolveGroupId(mission, a.group),
        file: a.resourceKey,
        start_delay: a.delaySeconds ?? 0,
      };
    case "stop_sound":
      return { predicate: "a_out_sound_stop" };
    case "wait_for_user_flag":
      // 999 is the Mission Editor's default "flag back" slot.
      return { predicate: "c_start_wait_for_user", flag: a.flag, flag_back: a.flagBack ?? 999 };
    case "radio_transmission":
      return {
        predicate: "a_radio_transmission",
        file: a.resourceKey,
        zone: resolveZoneId(mission, a.zone),
        modulation: a.modulationAM ?? true,
        loop: a.loop ?? false,
        // DCS stores MHz in the rule and emits Hz in the compiled call.
        frequency: a.frequencyMHz,
        power: a.power ?? 100,
        name: a.name,
        start_delay: a.delaySeconds ?? 0,
        mic_effects: a.micEffects ?? true,
        squelch_effects: a.squelchEffects ?? true,
      };

    // --- scripting ---
    case "do_script":
      return { predicate: "a_do_script", text: a.text };
    case "do_script_file":
      return { predicate: "a_do_script_file", file: a.resourceKey };
    case "explode_unit":
      return { predicate: "a_explosion_unit", unit: resolveUnitId(mission, a.unit), volume: a.power ?? 100 };
    case "smoke_marker":
      return {
        predicate: "a_explosion_marker",
        zone: resolveZoneId(mission, a.zone),
        altitude: a.altitudeMetres ?? 1,
        color: String(a.color ?? 0),
      };
    case "smoke_marker_unit":
      return {
        predicate: "a_explosion_marker_unit",
        unit: resolveUnitId(mission, a.unit),
        color: String(a.color ?? 0),
        ...(a.name === undefined ? {} : { name: a.name }),
      };
    case "signal_flare_unit":
      return {
        predicate: "a_signal_flare_unit",
        unit: resolveUnitId(mission, a.unit),
        color: String(a.color ?? 0),
        bearing: a.bearing ?? 0,
      };
    case "picture_to_coalition":
      return {
        predicate: "a_out_picture_s",
        coalitionlist: a.coalition,
        file: a.resourceKey,
        seconds: a.seconds ?? 10,
        clearview: a.clearview ?? false,
        start_delay: a.delaySeconds ?? 0,
        horzAlignment: String(a.horizontalAlignment ?? 0),
        vertAlignment: String(a.verticalAlignment ?? 0),
        size: a.size ?? 15,
        size_units: String(a.sizeUnits ?? 0),
      };
    case "mark_to_all": {
      // The label and the comment are two separate dictionary entries, with the
      // editor's own prefixes; both come off the shared maxDictId counter.
      const text = messageText(mission, dictionary, a.text);
      const comment = dictionary
        ? allocateDictKey(mission, dictionary, a.comment ?? "", "DictKey_ActionComment_")
        : a.comment ?? "";
      return {
        predicate: "a_mark_to_all",
        value: a.id,
        text,
        KeyDict_text: text,
        zone: resolveZoneId(mission, a.zone),
        readonly: a.readonly ?? false,
        comment,
        KeyDict_comment: comment,
      };
    }
    case "add_radio_item_for_coalition":
      return {
        predicate: "a_add_radio_item_for_coalition",
        coalitionlist: a.coalition,
        ...radioText(mission, dictionary, a.text),
        flag: String(a.flag),
        value: a.value ?? 1,
      };
    case "set_atc_silent_mode":
      return {
        predicate: "a_set_ATC_silent_mode",
        object: a.airdromeId,
        data: { type: "airdromeId" },
        silent: a.silent ?? true,
      };
    case "shelling_zone":
      return {
        predicate: "a_shelling_zone",
        zone: resolveZoneId(mission, a.zone),
        TNT: a.tnt,
        shells_count: a.shells,
      };
    case "resize_zone":
      return { predicate: "a_zone_increment_resize", zone: resolveZoneId(mission, a.zone), meters: a.metres };
    case "ai_task": {
      const task: LuaTable = {};
      task[1] = resolveGroupId(mission, a.group);
      task[2] = a.taskNumber;
      return { predicate: "a_ai_task", ai_task: task };
    }
  }
}

// --- compiled `mission.trig` emission --------------------------------------

/** Raised when a trigrule uses a predicate this compiler has no verified mapping for. */
class UncompilablePredicate extends Error {}

/**
 * Join compiled condition calls the way the editor does: ` and ` between
 * tests, and a bare ` or ` wherever the rule list carries an `or` separator.
 * The editor's OR condition group therefore comes out as
 * `A and B or C and D` - Lua's own precedence, which is what DCS runs.
 */
function joinConditions(parts: string[]): string {
  let out = "";
  let afterOr = false;
  for (const part of parts) {
    if (part === OR_MARKER) { out += " or"; afterOr = true; continue; }
    out += out === "" ? part : `${afterOr ? " " : " and "}${part}`;
    afterOr = false;
  }
  // A list that starts or ends on a separator would compile to invalid Lua.
  if (out.startsWith(" or") || out.endsWith(" or")) {
    throw new UncompilablePredicate("an 'or' separator needs a condition on both sides");
  }
  return out;
}

/**
 * The trailing `start_delay` of the text, sound and end-mission actions.
 *
 * The editor emits it whether or not the rule carries the field: across 3024
 * editor-saved missions (29023 recompiled triggers) the four-argument form of
 * `a_out_text_delay` appears only in missions whose `trig` predates their
 * trigrules. So it is always written, defaulting to 0.
 */
function optionalDelay(rule: LuaTable): string {
  return `, ${argNumberOr(rule, "start_delay", 0)}`;
}

/**
 * Whether a rule carries a field at all. Some editor actions compile with an
 * extra argument only when the field is present, so its absence is meaningful
 * and must not be defaulted away.
 */
function has(rule: LuaTable, field: string): boolean {
  return rule[field] !== undefined;
}

function argNumber(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UncompilablePredicate(`'${field}' is not a number`);
  }
  return String(value);
}

function argString(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value !== "string") throw new UncompilablePredicate(`'${field}' is not a string`);
  return quoteLuaString(value);
}

function argBool(rule: LuaTable, field: string, fallback: boolean): string {
  const value = rule[field];
  return (typeof value === "boolean" ? value : fallback) ? "true" : "false";
}

/** Optional string arg with a default, for fields the editor leaves out. */
function argStringOr(rule: LuaTable, field: string, fallback: string): string {
  const value = rule[field];
  return quoteLuaString(typeof value === "string" ? value : fallback);
}

/** Optional numeric arg with a default, for fields older missions may omit. */
function argNumberOr(rule: LuaTable, field: string, fallback: number): string {
  const value = rule[field];
  return String(typeof value === "number" && Number.isFinite(value) ? value : fallback);
}

/**
 * Pass a stored value through with its own type: a number compiles bare, a
 * string compiles quoted. The editor stores some arguments either way - a
 * signal flare's `bearing` is `"0"` when it is zero and `90` when it is not -
 * and DCS reads both, so the type is preserved rather than normalised.
 */
function argValue(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return quoteLuaString(value);
  throw new UncompilablePredicate(`'${field}' is not a number or a string`);
}

/** A flag reference is a plain integer id or a named flag string. */
function argFlag(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return quoteLuaString(value);
  throw new UncompilablePredicate(`'${field}' is not a flag id or name`);
}

/** Message text: a dictionary key resolves at runtime, a literal passes straight through. */
function argText(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value !== "string") throw new UncompilablePredicate(`'${field}' is not a string`);
  return value.startsWith("DictKey_") || value === ""
    ? `getValueDictByKey(${quoteLuaString(value)})`
    : quoteLuaString(value);
}

/**
 * Condition predicate -> runtime call. Signatures captured verbatim from
 * Mission-Editor-saved missions.
 */
const CONDITION_COMPILERS: Record<string, (r: LuaTable) => string> = {
  c_time_after: (r) => `c_time_after(${argNumber(r, "seconds")})`,
  c_time_since_flag: (r) => `c_time_since_flag(${argFlag(r, "flag")}, ${argNumber(r, "seconds")})`,
  c_flag_is_true: (r) => `c_flag_is_true(${argFlag(r, "flag")})`,
  c_flag_is_false: (r) => `c_flag_is_false(${argFlag(r, "flag")})`,
  c_flag_equals: (r) => `c_flag_equals(${argFlag(r, "flag")}, ${argNumber(r, "value")})`,
  c_flag_more: (r) => `c_flag_more(${argFlag(r, "flag")}, ${argNumber(r, "value")})`,
  c_unit_in_zone: (r) => `c_unit_in_zone(${argNumber(r, "unit")}, ${argNumber(r, "zone")})`,
  c_unit_out_zone: (r) => `c_unit_out_zone(${argNumber(r, "unit")}, ${argNumber(r, "zone")})`,
  c_unit_dead: (r) => `c_unit_dead(${argNumber(r, "unit")})`,
  c_group_dead: (r) => `c_group_dead(${argNumber(r, "group")})`,
  c_group_life_less: (r) => `c_group_life_less(${argNumber(r, "group")}, ${argNumber(r, "percent")})`,
  c_part_of_group_in_zone: (r) =>
    `c_part_of_group_in_zone(${argNumber(r, "group")}, ${argNumber(r, "zone")})`,
  c_part_of_coalition_in_zone: (r) =>
    `c_part_of_coalition_in_zone(${argString(r, "coalitionlist")}, ${argNumber(r, "zone")}, ${argString(r, "unitType")})`,
  c_random_less: (r) => `c_random_less(${argNumber(r, "percent")})`,
  c_group_alive: (r) => `c_group_alive(${argNumber(r, "group")})`,
  c_unit_damaged: (r) => `c_unit_damaged(${argNumber(r, "unit")})`,
  c_all_of_group_in_zone: (r) => `c_all_of_group_in_zone(${argNumber(r, "group")}, ${argNumber(r, "zone")})`,
  c_part_of_group_out_zone: (r) =>
    `c_part_of_group_out_zone(${argNumber(r, "group")}, ${argNumber(r, "zone")})`,
  c_unit_in_zone_unit: (r) =>
    `c_unit_in_zone_unit(${argNumber(r, "unit")}, ${argNumber(r, "zone")}, ${argNumber(r, "zoneunit")})`,
  c_unit_altitude_higher: (r) => `c_unit_altitude_higher(${argNumber(r, "unit")}, ${argNumber(r, "altitude")})`,
  c_unit_altitude_higher_AGL: (r) =>
    `c_unit_altitude_higher_AGL(${argNumber(r, "unit")}, ${argNumber(r, "altitude")})`,
  c_unit_altitude_lower: (r) => `c_unit_altitude_lower(${argNumber(r, "unit")}, ${argNumber(r, "altitude")})`,
  c_missile_in_zone: (r) =>
    `c_missile_in_zone(${argWeaponSelector(r, "typemissile")}, ${argNumber(r, "nummissiles")}, ${argNumber(r, "zone")})`,
  c_bomb_in_zone: (r) =>
    `c_bomb_in_zone(${argWeaponSelector(r, "typebomb")}, ${argNumber(r, "numbombs")}, ${argNumber(r, "zone")})`,
  // `or` emits no call of its own: compileTrig joins around it (see OR_MARKER).
  or: () => OR_MARKER,
};

/** The separator `or` compiles to, recognised by the condition join. */
const OR_MARKER = "or";

/**
 * The editor joins the four-number weapon selector with dots into ONE string
 * argument (`"4.4.11.125"`). Older missions carry a single number there instead;
 * that form has no oracle record, so it is refused and the existing compiled
 * entry is preserved rather than rewritten from a guess.
 */
function argWeaponSelector(rule: LuaTable, field: string): string {
  const table = asTable(rule[field]);
  if (!table) throw new UncompilablePredicate(`'${field}' is not a weapon selector table`);
  const numbers = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => table[k]);
  if (!numbers.length) throw new UncompilablePredicate(`'${field}' is empty`);
  if (numbers.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new UncompilablePredicate(`'${field}' holds a non-numeric entry`);
  }
  return quoteLuaString(numbers.join("."));
}

/** A resource reference resolves through the mission's mapResource at runtime. */
function argResource(rule: LuaTable, field: string): string {
  const value = rule[field];
  if (typeof value !== "string") throw new UncompilablePredicate(`'${field}' is not a resource key`);
  return `getValueResourceByKey(${quoteLuaString(value)})`;
}

/**
 * `a_set_ATC_silent_mode` names its object kind in `data.type`. Only
 * `airdromeId` appears in any editor-saved mission available here, so any other
 * kind is refused instead of being written from a guess.
 */
function argAtcObjectKey(rule: LuaTable): string {
  const type = asTable(rule["data"])?.["type"];
  if (type !== "airdromeId") {
    throw new UncompilablePredicate(`unsupported a_set_ATC_silent_mode object type '${String(type)}'`);
  }
  return "airdromeId";
}

/** Radio menu labels sit in `radiotext`, not `text`. */
function argRadioText(rule: LuaTable): string {
  return argText(rule, "radiotext");
}

/** Action predicate -> runtime call. Same provenance as the conditions above. */
const ACTION_COMPILERS: Record<string, (a: LuaTable) => string> = {
  a_out_text_delay: (a) =>
    `a_out_text_delay(${argText(a, "text")}, ${argNumber(a, "seconds")}, ${argBool(a, "clearview", false)}${optionalDelay(a)})`,
  a_out_text_delay_s: (a) =>
    `a_out_text_delay_s(${argString(a, "coalitionlist")}, ${argText(a, "text")}, ${argNumber(a, "seconds")}, ${argBool(a, "clearview", false)}${optionalDelay(a)})`,
  // Unlike the other per-audience messages this one DOES take a delay: the
  // editor emits a fifth argument here too (the repo previously recorded the
  // opposite, from a narrower corpus).
  a_out_text_delay_g: (a) =>
    `a_out_text_delay_g(${argNumber(a, "group")}, ${argText(a, "text")}, ${argNumber(a, "seconds")}, ` +
    `${argBool(a, "clearview", false)}${optionalDelay(a)})`,
  a_set_flag: (a) => `a_set_flag(${argFlag(a, "flag")})`,
  a_set_flag_value: (a) => `a_set_flag_value(${argFlag(a, "flag")}, ${argNumber(a, "value")})`,
  a_clear_flag: (a) => `a_clear_flag(${argFlag(a, "flag")})`,
  a_activate_group: (a) => `a_activate_group(${argNumber(a, "group")})`,
  a_deactivate_group: (a) => `a_deactivate_group(${argNumber(a, "group")})`,
  a_group_on: (a) => `a_group_on(${argNumber(a, "group")})`,
  a_group_off: (a) => `a_group_off(${argNumber(a, "group")})`,
  a_group_resume: (a) => `a_group_resume(${argNumber(a, "group")})`,
  a_explosion: (a) =>
    `a_explosion(${argNumber(a, "zone")}, ${argNumberOr(a, "altitude", 1)}, ${argNumber(a, "volume")})`,
  a_effect_smoke: (a) =>
    `a_effect_smoke(${argNumber(a, "zone")}, ${argNumber(a, "preset")}, ${argNumber(a, "density")}, ${argString(a, "name")})`,
  a_signal_flare: (a) =>
    `a_signal_flare(${argNumber(a, "zone")}, ${argNumberOr(a, "altitude", 1)}, ${argString(a, "color")}, ${argValue(a, "bearing")})`,
  a_out_text_delay_u: (a) =>
    `a_out_text_delay_u(${argNumber(a, "unit")}, ${argText(a, "text")}, ${argNumber(a, "seconds")}, ${argBool(a, "clearview", false)}${optionalDelay(a)})`,
  a_out_text_delay_c: (a) =>
    `a_out_text_delay_c(${argNumber(a, "countrylist")}, ${argText(a, "text")}, ${argNumber(a, "seconds")}, ${argBool(a, "clearview", false)}${optionalDelay(a)})`,
  a_set_flag_random: (a) =>
    `a_set_flag_random(${argFlag(a, "flag")}, ${argNumber(a, "min_value")}, ${argNumber(a, "max_value")})`,
  a_end_mission: (a) =>
    `a_end_mission(${argString(a, "winner")}, ${argText(a, "text")}${optionalDelay(a)})`,

  // --- radio menu ---
  a_add_radio_item: (a) =>
    `a_add_radio_item(${argRadioText(a)}, ${argFlag(a, "flag")}, ${argNumberOr(a, "value", 1)})`,
  a_add_radio_item_for_group: (a) =>
    `a_add_radio_item_for_group(${argNumber(a, "group")}, ${argRadioText(a)}, ${argFlag(a, "flag")}, ${argNumberOr(a, "value", 1)})`,
  a_remove_radio_item: (a) => `a_remove_radio_item(${argRadioText(a)})`,
  a_remove_radio_item_for_group: (a) =>
    `a_remove_radio_item_for_group(${argNumber(a, "group")}, ${argRadioText(a)})`,

  // --- sound and radio ---
  a_out_sound: (a) => `a_out_sound(${argResource(a, "file")}${optionalDelay(a)})`,
  a_out_sound_s: (a) =>
    `a_out_sound_s(${argString(a, "coalitionlist")}, ${argResource(a, "file")}${optionalDelay(a)})`,
  a_out_sound_u: (a) =>
    `a_out_sound_u(${argNumber(a, "unit")}, ${argResource(a, "file")}${optionalDelay(a)})`,
  a_out_sound_g: (a) =>
    `a_out_sound_g(${argNumber(a, "group")}, ${argResource(a, "file")}${optionalDelay(a)})`,
  a_out_sound_stop: () => `a_out_sound_stop()`,
  // Despite the `c_` name these are ACTIONS: DCS stores them in a trigrule's
  // `actions` array, not its `rules`.
  // `flag_back` is a flag reference like any other: the editor writes it as a
  // string in its own missions, so the stored type is preserved rather than
  // forced to a number (which defaulted a real `"0"` away to 999).
  c_start_wait_for_user: (a) =>
    `c_start_wait_for_user(${argFlag(a, "flag")}, ${has(a, "flag_back") ? argFlag(a, "flag_back") : "999"})`,
  c_stop_wait_for_user: () => `c_stop_wait_for_user()`,
  /**
   * Three lengths, two of them field-driven and one not.
   *
   * Eight arguments is the base. The editor adds `mic_effects` and
   * `squelch_effects` when the rule carries them, then a subtitle argument when
   * it carries `text`. It ALSO writes a twelfth argument in some missions whose
   * specs are identical to eleven-argument ones, so that one is a DCS-version
   * artefact nothing in the rule explains - it is never emitted here, and the
   * eleven-argument form it rewrites to is the editor's own output too.
   */
  a_radio_transmission: (a) => {
    const base =
      `a_radio_transmission(${argResource(a, "file")}, ${argNumber(a, "zone")}, ${argBool(a, "modulation", true)}, ` +
      `${argBool(a, "loop", false)}, ${megahertzToHertz(a)}, ${argNumber(a, "power")}, ${argString(a, "name")}, ` +
      `${argNumberOr(a, "start_delay", 0)}`;
    const effects =
      has(a, "mic_effects") || has(a, "squelch_effects")
        ? `, ${argBool(a, "mic_effects", true)}, ${argBool(a, "squelch_effects", true)}`
        : "";
    const subtitle = has(a, "text") ? `, ${argText(a, "text")}` : "";
    return `${base}${effects}${subtitle})`;
  },

  // --- scripting ---
  a_do_script: (a) => `a_do_script(${argString(a, "text")})`,
  a_do_script_file: (a) => `a_do_script_file(${argResource(a, "file")})`,
  a_explosion_unit: (a) => `a_explosion_unit(${argNumber(a, "unit")}, ${argNumber(a, "volume")})`,
  // The marker's `name` is the only field-driven argument here: the corpus has
  // both three- and four-argument calls for specs with the SAME fields (871 to
  // 547), so the fourth is a DCS-version difference, and it is written only when
  // the rule actually carries a name.
  a_explosion_marker: (a) =>
    `a_explosion_marker(${argNumber(a, "zone")}, ${argNumberOr(a, "altitude", 1)}, ${argStringOr(a, "color", "0")}` +
    `${has(a, "name") ? `, ${argString(a, "name")}` : ""})`,
  a_explosion_marker_unit: (a) =>
    `a_explosion_marker_unit(${argNumber(a, "unit")}, ${argStringOr(a, "color", "0")}` +
    `${has(a, "name") ? `, ${argString(a, "name")}` : ""})`,
  a_signal_flare_unit: (a) =>
    `a_signal_flare_unit(${argNumber(a, "unit")}, ${argStringOr(a, "color", "0")}, ${argValue(a, "bearing")})`,
  a_out_picture_s: (a) =>
    `a_out_picture_s(${argString(a, "coalitionlist")}, ${argResource(a, "file")}, ${argNumber(a, "seconds")}, ` +
    `${argBool(a, "clearview", false)}, ${argNumberOr(a, "start_delay", 0)}, ${argString(a, "horzAlignment")}, ` +
    `${argString(a, "vertAlignment")}, ${argNumber(a, "size")}, ${argString(a, "size_units")})`,
  a_mark_to_all: (a) =>
    `a_mark_to_all(${argNumber(a, "value")}, ${argText(a, "text")}, ${argNumber(a, "zone")}, ` +
    `${argBool(a, "readonly", false)}, ${argText(a, "comment")})`,
  a_add_radio_item_for_coalition: (a) =>
    `a_add_radio_item_for_coalition(${argString(a, "coalitionlist")}, ${argRadioText(a)}, ${argFlag(a, "flag")}, ${argNumber(a, "value")})`,
  // The object is written as an inline table keyed by the `data.type` the rule
  // names, which is `airdromeId` in every editor-saved record available here.
  a_set_ATC_silent_mode: (a) =>
    `a_set_ATC_silent_mode({${argAtcObjectKey(a)}=${argNumber(a, "object")}}, ${argBool(a, "silent", true)})`,
  a_shelling_zone: (a) =>
    `a_shelling_zone(${argNumber(a, "zone")}, ${argNumber(a, "TNT")}, ${argNumber(a, "shells_count")})`,
  a_zone_increment_resize: (a) =>
    `a_zone_increment_resize(${argNumber(a, "zone")}, ${argNumber(a, "meters")})`,
  a_ai_task: (a) => {
    const pair = asTable(a["ai_task"]);
    const group = pair?.[1];
    const number = pair?.[2];
    if (typeof group !== "number" || typeof number !== "number") {
      throw new UncompilablePredicate("'ai_task' is not a {groupId, taskNumber} pair");
    }
    return `a_ai_task(${group}, ${number})`;
  },
};

/** `a_radio_transmission` stores MHz in the rule but takes Hz in the compiled call. */
function megahertzToHertz(rule: LuaTable): string {
  const mhz = rule["frequency"];
  if (typeof mhz !== "number" || !Number.isFinite(mhz)) {
    throw new UncompilablePredicate("'frequency' is not a number");
  }
  return String(Math.round(mhz * 1000));
}

/** `if cond() then actions() end` — the wiring the ME emits for most trigger types. */
function plainFunc(index: number): string {
  return `if mission.trig.conditions[${index}]() then mission.trig.actions[${index}]() end`;
}

/** `triggerFront` fires once per false->true transition, latched through `trig.flag`. */
function edgeFunc(index: number): string {
  return (
    `if mission.trig.conditions[${index}]() then ` +
    `if not mission.trig.flag[${index}] then mission.trig.actions[${index}](); ` +
    `mission.trig.flag[${index}] = true;end; else mission.trig.flag[${index}] = false; end;`
  );
}

function ensureTrigTables(mission: LuaTable): Record<string, LuaTable> {
  const trig = (mission["trig"] ??= {}) as LuaTable;
  const section = (key: string): LuaTable => (trig[key] ??= {}) as LuaTable;
  return {
    conditions: section("conditions"),
    actions: section("actions"),
    func: section("func"),
    funcStartup: section("funcStartup"),
    flag: section("flag"),
    custom: section("custom"),
    customStartup: section("customStartup"),
    events: section("events"),
  };
}

export interface CompileTrigResult {
  /** trigrule indices whose compiled `trig` entries were (re)written. */
  compiled: number[];
  /** trigrule indices left untouched because a predicate has no verified mapping. */
  skipped: number[];
}

/**
 * Compile `mission.trigrules` into the runtime `mission.trig` tables so triggers
 * fire when the `.miz` is flown directly, without a Mission Editor round-trip.
 *
 * Indices using a predicate we have no ground-truth mapping for are reported in
 * `skipped` and their existing compiled entries are left exactly as they are —
 * regenerating them from a guess would break triggers that already work.
 */
export function compileTrig(mission: LuaTable): CompileTrigResult {
  const trig = ensureTrigTables(mission);
  const compiled: number[] = [];
  const skipped: number[] = [];

  luaArray(mission["trigrules"]).forEach((rule, i) => {
    const index = i + 1;
    const type = rule["predicate"];

    // An event-driven trigger (ME "event" field, e.g. eventlist="shot") is wired
    // into mission.trig.events[<event>][i] with its own disarm, not func[i]. We
    // have no oracle for that wiring, so leave its compiled Lua exactly as it is.
    if (hasEventList(rule)) {
      skipped.push(index);
      return;
    }

    let condition: string;
    let action: string;
    try {
      const conditions = luaArray(rule["rules"]).map((c) => {
        const compile = CONDITION_COMPILERS[String(c["predicate"])];
        if (!compile) throw new UncompilablePredicate(String(c["predicate"]));
        return compile(c);
      });
      const actions = luaArray(rule["actions"]).map((a) => {
        const compile = ACTION_COMPILERS[String(a["predicate"])];
        if (!compile) throw new UncompilablePredicate(String(a["predicate"]));
        return compile(a);
      });
      // No conditions means "always", which the ME compiles to `return(true)`.
      condition = conditions.length === 0 ? "return(true)" : `return(${joinConditions(conditions)} )`;
      action = actions.map((call) => `${call};`).join("");
    } catch (err) {
      if (err instanceof UncompilablePredicate) {
        skipped.push(index);
        return;
      }
      throw err;
    }

    // A `triggerOnce` disarms itself by clearing its own func slot.
    if (type === "triggerOnce") action += ` mission.trig.func[${index}]=nil;`;

    trig.conditions[index] = condition;
    trig.actions[index] = action;
    trig.flag[index] = true;

    if (type === "triggerStart") {
      trig.funcStartup[index] = plainFunc(index);
      delete trig.func[index];
    } else {
      trig.func[index] = type === "triggerFront" ? edgeFunc(index) : plainFunc(index);
      delete trig.funcStartup[index];
    }
    compiled.push(index);
  });

  return { compiled, skipped };
}

export interface TriggerArgs {
  type: TriggerType;
  comment?: string;
  conditions: ConditionSpec[];
  actions: ActionSpec[];
}

/**
 * Add a mission trigger, writing both the Mission Editor's structured form
 * (`trigrules`) and the compiled runtime form (`trig`), so the trigger fires
 * without opening the mission in the editor first.
 *
 * Pass the session `dictionary` so message text is stored the way the ME stores
 * it, behind a `DictKey_...`. Group/unit/zone names are resolved to DCS ids here
 * and an unknown name throws rather than producing a silently dead trigger.
 */
export function addTrigger(mission: LuaTable, args: TriggerArgs, dictionary?: LuaTable): number {
  const trigrules = (mission["trigrules"] ??= {}) as LuaTable;
  const rules: LuaTable = {};
  args.conditions.forEach((c, i) => {
    rules[i + 1] = conditionRule(mission, c);
  });
  const actions: LuaTable = {};
  args.actions.forEach((a, i) => {
    actions[i + 1] = actionRule(mission, a, dictionary);
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
  compileTrig(mission);
  return index;
}

/** True when a trigrule is bound to a world event (ME "event" field). */
function hasEventList(rule: LuaTable): boolean {
  const events = rule["eventlist"];
  return typeof events === "string" ? events.trim() !== "" : events !== undefined && events !== null;
}

/** Predicates of a trigrule this server cannot compile, if any. */
function uncompilablePredicates(rule: LuaTable): string[] {
  const missing: string[] = [];
  if (hasEventList(rule)) missing.push(`eventlist "${String(rule["eventlist"])}"`);
  for (const c of luaArray(rule["rules"])) {
    if (!CONDITION_COMPILERS[String(c["predicate"])]) missing.push(String(c["predicate"]));
  }
  for (const a of luaArray(rule["actions"])) {
    if (!ACTION_COMPILERS[String(a["predicate"])]) missing.push(String(a["predicate"]));
  }
  return missing;
}

/** Shift every `trig.<section>[k]` with k > index down by one, dropping k == index. */
function shiftTrigSection(section: LuaTable | undefined, index: number): LuaTable | undefined {
  if (!section) return undefined;
  const out: LuaTable = {};
  for (const [key, value] of Object.entries(section)) {
    const k = Number(key);
    if (!Number.isInteger(k)) {
      out[key] = value;
    } else if (k < index) {
      out[k] = value;
    } else if (k > index) {
      out[k - 1] = value;
    }
  }
  return out;
}

/**
 * Remove trigger #index from both `trigrules` and the compiled `trig` tables.
 *
 * Every later trigger moves down one slot, and its compiled Lua names its own
 * slot (`mission.trig.func[i]=nil`, `trig.flag[i]`), so each one must be
 * recompiled. A later trigger that uses a predicate with no verified compiler
 * cannot be safely renumbered — rewriting its compiled Lua from a guess is
 * exactly what compileTrig refuses to do — so removal is refused instead, and
 * the editor is the right tool for that mission. Removing the LAST trigger, or
 * any trigger after which everything is compilable, is always safe.
 */
export function removeTrigger(mission: LuaTable, index: number): { removed: string; recompiled: number[] } {
  const trigrules = asTable(mission["trigrules"]);
  const rules = luaArray(trigrules);
  if (!trigrules || index < 1 || index > rules.length) {
    throw new Error(`No trigger #${index}; this mission has ${rules.length}.`);
  }
  for (let j = index + 1; j <= rules.length; j++) {
    const missing = uncompilablePredicates(rules[j - 1]);
    if (missing.length) {
      throw new Error(
        `Cannot remove trigger #${index}: trigger #${j} ('${String(rules[j - 1]["comment"] ?? "")}') uses ` +
          `${[...new Set(missing)].join(", ")}, which this server has no verified compiler for. Removing ` +
          `#${index} would renumber #${j} and break its compiled Lua. Remove it in the Mission Editor instead.`
      );
    }
  }
  const trig = asTable(mission["trig"]);
  for (const key of ["custom", "customStartup", "events"]) {
    const section = asTable(trig?.[key]);
    const occupied = Object.keys(section ?? {})
      .map(Number)
      .filter((k) => Number.isInteger(k) && k > index);
    if (occupied.length) {
      throw new Error(
        `Cannot remove trigger #${index}: mission.trig.${key} has entries for later triggers ` +
          `(${occupied.join(", ")}) whose format is not verified. Remove it in the Mission Editor instead.`
      );
    }
  }

  const removed = String(rules[index - 1]["comment"] ?? "");
  const next: LuaTable = {};
  rules.filter((_, i) => i !== index - 1).forEach((r, i) => {
    next[i + 1] = r;
  });
  mission["trigrules"] = next;
  if (trig) {
    for (const key of ["conditions", "actions", "func", "funcStartup", "flag", "custom", "customStartup", "events"]) {
      const shifted = shiftTrigSection(asTable(trig[key]), index);
      if (shifted) trig[key] = shifted;
    }
  }
  const { compiled } = compileTrig(mission);
  return { removed, recompiled: compiled.filter((i) => i >= index) };
}

/** Change a trigger's type and/or comment, recompiling its runtime wiring. */
export function updateTrigger(
  mission: LuaTable,
  index: number,
  changes: { type?: TriggerType; comment?: string }
): void {
  const rule = asTable(asTable(mission["trigrules"])?.[index]);
  if (!rule) throw new Error(`No trigger #${index} in this mission`);
  if (changes.type) {
    const missing = uncompilablePredicates(rule);
    if (missing.length) {
      throw new Error(
        `Trigger #${index} uses ${[...new Set(missing)].join(", ")}, which this server cannot compile; ` +
          `changing its type would leave the compiled Lua wired for the old type.`
      );
    }
    rule["predicate"] = TRIGGER_PREDICATE[changes.type];
  }
  if (changes.comment !== undefined) rule["comment"] = changes.comment;
  compileTrig(mission);
}

/** Find a trigger by its Mission Editor comment. Returns the 1-based index. */
export function findTriggerByComment(mission: LuaTable, comment: string): number | undefined {
  const rules = luaArray(mission["trigrules"]);
  for (let i = 0; i < rules.length; i++) {
    if (rules[i]["comment"] === comment) return i + 1;
  }
  return undefined;
}

/**
 * Append actions to an existing trigger, preserving order.
 *
 * Actions inside one trigger compile into a single Lua chunk that runs top to
 * bottom, which is the only ordering DCS actually guarantees: `trig.func` and
 * `trig.funcStartup` are walked with `pairs`, so SEPARATE triggers have no
 * defined order between them. Anything order-dependent — loading MIST before
 * Skynet, for instance — must therefore live in one trigger.
 */
export function appendTriggerActions(
  mission: LuaTable,
  index: number,
  actions: ActionSpec[],
  dictionary?: LuaTable
): number {
  const rule = asTable(asTable(mission["trigrules"])?.[index]);
  if (!rule) throw new Error(`No trigger #${index} in this mission`);
  const existing = (rule["actions"] ??= {}) as LuaTable;
  let next = nextIndex(existing);
  for (const action of actions) {
    existing[next++] = actionRule(mission, action, dictionary);
  }
  compileTrig(mission);
  return next - 1;
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
    // Present in every ME-saved mission (37/37 sampled). Without these and the
    // player unit's identity fields (see applyEditorAircraftDefaults), DCS
    // 2.9.31 returns nil from DCS.getPlayerBriefing() and the briefing screen
    // fails with "attempt to index global 'dataBrf'" — no player slot results.
    descriptionNeutralsTask: "",
    pictureFileNameB: {},
    pictureFileNameR: {},
    pictureFileNameN: {},
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

/** Validate known physical limits without executing Lua or assuming mod capabilities. */
/**
 * Payload values above the BUNDLED limit, which is not the same as above the aircraft's.
 * The counts are pydcs's, and the installed DCS has moved on: ME-saved missions carry an
 * F/A-18C with 90 flares where pydcs says 60, and the editor rounds internal fuel, which
 * can land a hair over `fuel_max` (a CH-47F at 3055 against 3054.592). So fuel gets a
 * rounding tolerance and the rest is reported, not refused — a refusal here would make
 * this server reject missions DCS flies.
 */
export function payloadOverCatalogue(unit: LuaTable, args: PayloadArgs): { key: string; value: number; limit: number }[] {
  const data = findUnitType(String(unit.type))?.entry as FlyingType | undefined;
  const out: { key: string; value: number; limit: number }[] = [];
  for (const [key, limit, tolerance] of [["fuel", data?.fuelMax, 1], ["chaff", data?.chaff, 0], ["flare", data?.flare, 0]] as const) {
    const value = args[key as "fuel" | "chaff" | "flare"];
    if (value === undefined || limit == null || !Number.isFinite(value)) continue;
    if (value > limit + Math.max(tolerance, limit * 0.001)) out.push({ key, value, limit });
  }
  return out;
}

/**
 * @param options.enforceCatalogueFuel refuse internal fuel above the catalogued maximum
 *   (plus a rounding tolerance). True when WRITING a payload — tank capacity is physical
 *   and well pinned, so a value far above it is a mistake worth refusing. False when
 *   CHECKING an existing mission, where the same value is reported as catalogue staleness
 *   instead: nothing this server does should reject a mission DCS flies.
 */
export function validatePayload(unit: LuaTable, args: PayloadArgs, options: { enforceCatalogueFuel?: boolean } = {}): void {
  const ref = findUnitType(String(unit.type));
  if (ref && !["plane", "helicopter"].includes(ref.category)) throw new Error("Payload requires an aircraft");
  // Structural faults. Countermeasure counts above the pydcs catalogue are NOT faults
  // (the editor saves an F/A-18C with 90 flares where pydcs says 60) — payloadOverCatalogue
  // reports those. `gun` is a percentage, so 0..100 is the format itself.
  for (const key of ["fuel", "chaff", "flare", "gun"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
    if (key === "gun" && value > 100) throw new Error("gun is a percentage of the magazine: 0..100");
  }
  if (options.enforceCatalogueFuel !== false) {
    const over = payloadOverCatalogue(unit, args).find(o => o.key === "fuel");
    if (over) throw new Error(`fuel ${over.value} is above the aircraft's catalogued maximum of ${over.limit} kg for ${String(unit.type)}`);
  }
  const seen = new Set<number>();
  const pylons = authoringData().aircraft[String(unit.type)]?.pylons;
  for (const p of args.pylons ?? []) {
    if (!Number.isInteger(p.pylon) || p.pylon < 1 || seen.has(p.pylon) || !p.CLSID.trim()) throw new Error("Invalid or duplicate payload pylon");
    seen.add(p.pylon);
    // An empty catalogue is unknown, not evidence that a new/mod aircraft is unarmed.
    if (pylons && Object.keys(pylons).length && !pylons[String(p.pylon)]?.includes(p.CLSID))
      throw new Error(`Weapon '${p.CLSID}' is not catalogued on ${unit.type} pylon ${p.pylon}`);
  }
}

function linkedAircraftCount(mission: LuaTable, unitId: number): number {
  let total = 0;
  eachGroup(mission, (group, category) => {
    if (!["plane", "helicopter"].includes(category)) return;
    const first = asTable(asTable(asTable(group.route)?.points)?.[1]);
    if (first?.linkUnit === unitId && String(first.type).startsWith("TakeOff")) total += luaArray(group.units).length;
  });
  return total;
}

/** Full replacement at a stable index; unrelated structured/compiled triggers remain untouched. */
export function replaceTrigger(mission: LuaTable, dictionary: LuaTable, index: number, spec: TriggerArgs): void {
  const copy = structuredClone(mission), dict = structuredClone(dictionary);
  const table = asTable(copy.trigrules);
  if (!table || !asTable(table[index])) throw new Error(`No trigger #${index}`);
  for (const section of ['custom', 'customStartup', 'events']) if (asTable(asTable(copy.trig)?.[section])?.[index] !== undefined)
    throw new Error(`Cannot safely replace trigger with opaque ${section} runtime data`);
  const temporary = addTrigger(copy, spec, dict);
  table[index] = table[temporary]; delete table[temporary];
  for (const section of Object.values(asTable(copy.trig) ?? {})) { const values = asTable(section); if (values) delete values[temporary]; }
  compileTrig(copy);
  Object.assign(mission, copy); Object.assign(dictionary, dict);
}

/** Discoverable scope of the captured compiler, not a claim to implement every DCS predicate. */
export function triggerCapabilities() {
  return { types: Object.keys(TRIGGER_PREDICATE), conditions: Object.keys(CONDITION_COMPILERS), actions: Object.keys(ACTION_COMPILERS),
    policy: "Only mappings backed by the project's Mission Editor oracle are emitted; unknown imported compiled triggers are preserved" };
}
