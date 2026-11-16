/**
 * Scene dressing: FARPs, airfields filled with parked statics, ground-target
 * areas built from static objects, and naval formations.
 *
 * Positions that come from DCS (parking slots, airfield reference points) are
 * ground truth. Layouts that this file arranges itself (target-area grids, FARP
 * support placement, ship stations) are conventions, and each says so.
 */
import { luaArray, type LuaTable } from "./lua.js";
import { findModUnit } from "../dcs/mods.js";
import { addAircraftGroup, addGroundGroup, chooseParking, countryId, ensureCountry, maxIds, occupiedParking, type Side } from "./authoring.js";
import { addStatic } from "./editing.js";
import { countryOffers, findAirport, findUnitType, resolveTheatreName, type ParkingSlotTuple } from "../data/reference.js";

const DEG = Math.PI / 180;

function normalizeRadians(r: number): number {
  const twoPi = 2 * Math.PI;
  return ((r % twoPi) + twoPi) % twoPi;
}

/** Offset (forward, right) metres from a point along a heading in degrees. */
function offset(x: number, y: number, headingDeg: number, forward: number, right: number): { x: number; y: number } {
  const h = headingDeg * DEG;
  return {
    x: x + forward * Math.cos(h) - right * Math.sin(h),
    y: y + forward * Math.sin(h) + right * Math.cos(h),
  };
}

// ---------------------------------------------------------------------------
// FARPs
// ---------------------------------------------------------------------------

/**
 * The three heliport statics, as pydcs's `unit.py` defines them (they are not
 * in its generated static catalogue): type id and the shape DCS draws.
 */
export const FARP_KINDS = {
  FARP: { type: "FARP", shape: "FARPS", pads: 4 },
  SINGLE_HELIPAD: { type: "SINGLE_HELIPAD", shape: "FARP", pads: 1 },
  INVISIBLE: { type: "Invisible FARP", shape: "invisiblefarp", pads: 1 },
} as const;

export type FarpKind = keyof typeof FARP_KINDS;

export interface AddFarpArgs {
  side: Side;
  country: string;
  countryId?: number;
  name: string;
  x: number;
  y: number;
  heading?: number;
  kind?: FarpKind;
  /** ATC frequency in MHz (default 127.5). */
  frequencyMHz?: number;
  /** 0 = AM, 1 = FM. */
  modulation?: 0 | 1;
  callsignId?: number;
  /**
   * Add the usual FARP dressing (ammo dump, fuel depot, command post, tent,
   * windsock) and a support-vehicle group. In DCS, rearm and refuel at a FARP
   * come from ground vehicles of the same coalition near the pad — a fuel
   * truck, an ammo truck and a command vehicle by common mission-maker practice
   * — not from the statics, which are scenery.
   */
  support?: boolean;
}

/** Support layout around the pad: (forward, right) metres, then type. */
const FARP_STATICS: { forward: number; right: number; type: string }[] = [
  { forward: -60, right: -40, type: "FARP Ammo Dump Coating" },
  { forward: -60, right: 40, type: "FARP Fuel Depot" },
  { forward: -90, right: 0, type: "FARP CP Blindage" },
  { forward: -90, right: -30, type: "FARP Tent" },
  { forward: 0, right: 70, type: "Windsock" },
];

const FARP_VEHICLES: Record<"blue" | "red", string[]> = {
  blue: ["M978 HEMTT Tanker", "M 818", "M1043 HMMWV Armament"],
  red: ["ATZ-10", "Ural-375", "ZIL-131 KUNG"],
};

export interface AddFarpResult {
  farp: string;
  statics: string[];
  supportGroup?: string;
}

export function addFarp(mission: LuaTable, args: AddFarpArgs): AddFarpResult {
  const kind = FARP_KINDS[args.kind ?? "FARP"];
  const country = ensureCountry(mission, args.side, args.country, countryId(args.country, args.countryId));
  const ids = maxIds(mission);
  const heading = normalizeRadians((args.heading ?? 0) * DEG);
  const unit: LuaTable = {
    name: args.name,
    unitId: ids.unitId + 1,
    type: kind.type,
    x: args.x,
    y: args.y,
    heading,
    category: "Heliports",
    shape_name: kind.shape,
    heliport_frequency: args.frequencyMHz ?? 127.5,
    heliport_modulation: args.modulation ?? 0,
    heliport_callsign_id: args.callsignId ?? 1,
  };
  const group: LuaTable = {
    name: args.name,
    groupId: ids.groupId + 1,
    heading,
    x: args.x,
    y: args.y,
    hidden: false,
    dead: false,
    units: { 1: unit },
    route: {
      points: { 1: { alt: 0, type: "", name: "", x: args.x, y: args.y, speed: 0, formation_template: "", action: "" } },
    },
  };
  const cat = (country["static"] ??= { group: {} }) as LuaTable;
  const groups = (cat["group"] ??= {}) as LuaTable;
  groups[luaArray(groups).length + 1] = group;

  const result: AddFarpResult = { farp: args.name, statics: [] };
  if (!args.support) return result;

  FARP_STATICS.forEach((s, i) => {
    const p = offset(args.x, args.y, args.heading ?? 0, s.forward, s.right);
    const name = `${args.name}-${s.type.replace(/^FARP /, "")}-${i + 1}`;
    addStatic(mission, { side: args.side, country: args.country, countryId: args.countryId, name, type: s.type, ...p, heading: args.heading });
    result.statics.push(name);
  });
  if (args.side !== "neutrals") {
    const p = offset(args.x, args.y, args.heading ?? 0, -130, 0);
    const supportGroup = `${args.name}-Support`;
    addGroundGroup(mission, "vehicle", {
      side: args.side,
      country: args.country,
      countryId: args.countryId,
      name: supportGroup,
      type: FARP_VEHICLES[args.side][0],
      count: 1,
      composition: FARP_VEHICLES[args.side].map((type) => ({ type, count: 1 })),
      ...p,
      heading: ((args.heading ?? 0) + 90) % 360,
      spacingMetres: 15,
    });
    result.supportGroup = supportGroup;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Filling an airfield with parked statics
// ---------------------------------------------------------------------------

export interface PopulateAirfieldArgs {
  side: Side;
  country: string;
  countryId?: number;
  airfield: string | number;
  /** Static types to park, used in turn (aircraft, vehicles or static objects). */
  types: string[];
  count: number;
  /** Name prefix; objects are named `<prefix>-1`, `<prefix>-2`, ... */
  namePrefix: string;
  /** Only shelters, only open slots, or any (default). */
  slots?: "any" | "shelters" | "open";
  /**
   * Heading in degrees for every object. When omitted, each object faces the
   * airfield reference point — a heuristic: the bundled parking data has slot
   * positions and sizes but no orientation.
   */
  heading?: number;
  /** Park them as wrecks (e.g. after a strike). */
  dead?: boolean;
}

export interface PopulateAirfieldResult {
  airfield: string;
  placed: { name: string; type: string; slot: string }[];
  /** Free slots left after placement (any type). */
  freeSlotsLeft: number;
}

/**
 * Park static objects on free parking slots, so an airfield looks lived in or
 * has something to strike. Slots used by a flight in this mission are skipped,
 * and the statics placed here are skipped in turn by later flights.
 */
export function populateAirfield(mission: LuaTable, args: PopulateAirfieldArgs): PopulateAirfieldResult {
  const theatreName = resolveTheatreName(String(mission["theatre"] ?? ""));
  if (!theatreName) throw new Error(`Unknown theatre '${String(mission["theatre"])}'.`);
  const airport = findAirport(theatreName, args.airfield);
  if (!args.types.length) throw new Error("Give at least one type to park.");
  const taken = occupiedParking(mission, airport);
  const placed: PopulateAirfieldResult["placed"] = [];

  const slotFilter = (s: ParkingSlotTuple) =>
    args.slots === "shelters" ? (s[4] & 8) !== 0 : args.slots === "open" ? (s[4] & 8) === 0 : true;

  for (let i = 0; i < args.count; i++) {
    const type = args.types[i % args.types.length];
    const kind = findUnitType(type);
    if (!kind) throw new Error(`Unknown type '${type}'. Find one with dcs_list_unit_types.`);
    let slot: ParkingSlotTuple | undefined;
    if (kind.category === "plane" || kind.category === "helicopter") {
      const filtered = { ...airport, slots: airport.slots.filter(slotFilter) };
      try {
        slot = chooseParking(filtered, kind.category, type, 1, taken)[0];
      } catch {
        slot = undefined;
      }
    } else {
      slot = airport.slots
        .filter((s) => !taken.has(s[1]) && slotFilter(s))
        .sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }))[0];
    }
    if (!slot) break;
    taken.add(slot[1]);
    const heading =
      args.heading ?? ((Math.atan2(airport.y - slot[3], airport.x - slot[2]) / DEG + 360) % 360);
    const name = `${args.namePrefix}-${i + 1}`;
    addStatic(mission, {
      side: args.side,
      country: args.country,
      countryId: args.countryId,
      name,
      type,
      x: slot[2],
      y: slot[3],
      heading,
      dead: args.dead,
    });
    placed.push({ name, type, slot: slot[1] });
  }
  const freeSlotsLeft = airport.slots.filter((s) => !taken.has(s[1]) && slotFilter(s)).length;
  return { airfield: airport.name, placed, freeSlotsLeft };
}

// ---------------------------------------------------------------------------
// Ground-target areas
// ---------------------------------------------------------------------------

export interface TargetTemplate {
  id: string;
  description: string;
  /** Objects in layout order; the grid fills row by row. */
  objects: { type: string; count: number }[];
  /** Metres between objects in the grid. */
  spacingMetres: number;
  columns: number;
}

/**
 * Static-object target sets. The types are from the DCS catalogue; the grid
 * arrangement is this project's convention (provenance: catalogue), not copied
 * from an editor mission.
 */
export const TARGET_TEMPLATES: TargetTemplate[] = [
  {
    id: "ammo-depot",
    description: "Ammunition depot: bunkered dumps, a depot building, crates, guard post.",
    objects: [
      { type: ".Ammunition depot", count: 2 },
      { type: "FARP Ammo Dump Coating", count: 4 },
      { type: "ammo_cargo", count: 4 },
      { type: "Container_watchtower", count: 1 },
    ],
    spacingMetres: 40,
    columns: 4,
  },
  {
    id: "fuel-depot",
    description: "Fuel storage: large tanks, pump station, fuel bladders.",
    objects: [
      { type: "Tank", count: 2 },
      { type: "Tank 2", count: 2 },
      { type: "Fuel tank", count: 2 },
      { type: "Pump station", count: 1 },
      { type: "FARP Fuel Depot", count: 2 },
    ],
    spacingMetres: 60,
    columns: 3,
  },
  {
    id: "command-post",
    description: "Command post: HQ building, bunker, comms tower, staff tents.",
    objects: [
      { type: ".Command Center", count: 1 },
      { type: "FARP CP Blindage", count: 2 },
      { type: "Comms tower M", count: 1 },
      { type: "Military staff", count: 1 },
      { type: "FARP Tent", count: 3 },
    ],
    spacingMetres: 35,
    columns: 4,
  },
  {
    id: "supply-yard",
    description: "Logistics yard: warehouses and stacked containers.",
    objects: [
      { type: "Warehouse", count: 2 },
      { type: "Container_20ft", count: 4 },
      { type: "Container_40ft", count: 4 },
      { type: "iso_container", count: 2 },
    ],
    spacingMetres: 30,
    columns: 4,
  },
  {
    id: "barracks",
    description: "Troop garrison: barracks, workshop, garages, tents.",
    objects: [
      { type: "Barracks 2", count: 3 },
      { type: "Repair workshop", count: 1 },
      { type: "Garage A", count: 2 },
      { type: "FARP Tent", count: 4 },
    ],
    spacingMetres: 40,
    columns: 4,
  },
];

export function findTargetTemplate(id: string): TargetTemplate {
  const hit = TARGET_TEMPLATES.find((t) => t.id === id.toLowerCase());
  if (!hit) {
    throw new Error(`Unknown target template '${id}'. Available: ${TARGET_TEMPLATES.map((t) => t.id).join(", ")}.`);
  }
  return hit;
}

export interface AddTargetAreaArgs {
  side: Side;
  country: string;
  countryId?: number;
  name: string;
  x: number;
  y: number;
  heading?: number;
  template: string;
  /** Also add a trigger zone named `name` covering the area (for triggers/scripts). */
  zone?: boolean;
  dead?: boolean;
}

export interface AddTargetAreaResult {
  objects: string[];
  /** Radius (metres) that covers every object, from the area centre. */
  radiusMetres: number;
}

/**
 * Lay a template out as a grid centred on x/y and rotated to the heading. Every
 * object is its own static group named `<name>-N`, the way the Mission Editor
 * stores statics, so each can be targeted, counted or referenced on its own.
 */
export function addTargetArea(mission: LuaTable, args: AddTargetAreaArgs): AddTargetAreaResult {
  const t = findTargetTemplate(args.template);
  const types = t.objects.flatMap((o) => Array.from({ length: o.count }, () => o.type));
  const rows = Math.ceil(types.length / t.columns);
  const objects: string[] = [];
  let radius = 0;
  types.forEach((type, i) => {
    const row = Math.floor(i / t.columns);
    const col = i % t.columns;
    const forward = ((rows - 1) / 2 - row) * t.spacingMetres;
    const right = (col - (t.columns - 1) / 2) * t.spacingMetres;
    radius = Math.max(radius, Math.hypot(forward, right));
    const p = offset(args.x, args.y, args.heading ?? 0, forward, right);
    const name = `${args.name}-${i + 1}`;
    addStatic(mission, {
      side: args.side,
      country: args.country,
      countryId: args.countryId,
      name,
      type,
      ...p,
      heading: args.heading,
      dead: args.dead,
    });
    objects.push(name);
  });
  return { objects, radiusMetres: Math.ceil(radius + t.spacingMetres) };
}

// ---------------------------------------------------------------------------
// Naval formations
// ---------------------------------------------------------------------------

export interface NavalTemplate {
  id: string;
  description: string;
  side: "blue" | "red";
  /** Lead first; stations are metres ahead (+) / astern (-) and right (+) / left (-) of the lead. */
  ships: { type: string; forward: number; right: number }[];
  /** Default air wing for `airWing: "auto"`; the lead ship is the deck. */
  airWing?: AirWingSquadron[];
}

export interface AirWingSquadron {
  type: string;
  count: number;
  category: "plane" | "helicopter";
}

/**
 * Ship formations. Ships of one group keep their stations relative to the lead,
 * so these become one group. Types are from the DCS catalogue; the stations are
 * a conventional screen (provenance: catalogue), spaced well beyond the 120 m
 * column the generic layout would give, which would put hulls on top of each
 * other at carrier scale.
 */
export const NAVAL_TEMPLATES: NavalTemplate[] = [
  {
    id: "csg",
    description: "US carrier strike group: CVN-71, a Ticonderoga cruiser ahead, two Arleigh Burke destroyers on the flanks.",
    side: "blue",
    ships: [
      { type: "CVN_71", forward: 0, right: 0 },
      { type: "TICONDEROG", forward: 3000, right: 0 },
      { type: "USS_Arleigh_Burke_IIa", forward: 1000, right: 2500 },
      { type: "USS_Arleigh_Burke_IIa", forward: 1000, right: -2500 },
    ],
    airWing: [
      { type: "FA-18C_hornet", count: 4, category: "plane" },
      { type: "F-14B", count: 2, category: "plane" },
      { type: "E-2C", count: 1, category: "plane" },
      { type: "S-3B Tanker", count: 1, category: "plane" },
      { type: "SH-60B", count: 1, category: "helicopter" },
    ],
  },
  {
    id: "lha-group",
    description: "Amphibious group: LHA-1 Tarawa with an Arleigh Burke and a Perry frigate.",
    side: "blue",
    ships: [
      { type: "LHA_Tarawa", forward: 0, right: 0 },
      { type: "USS_Arleigh_Burke_IIa", forward: 2000, right: 1000 },
      { type: "PERRY", forward: -1500, right: -1000 },
    ],
    airWing: [
      { type: "AV8BNA", count: 4, category: "plane" },
      { type: "CH-53E", count: 2, category: "helicopter" },
      { type: "UH-1H", count: 2, category: "helicopter" },
    ],
  },
  {
    id: "kuznetsov-group",
    description: "Russian carrier group: Admiral Kuznetsov, Pyotr Velikiy, Neustrashimy and Rezky.",
    side: "red",
    ships: [
      { type: "CV_1143_5", forward: 0, right: 0 },
      { type: "PIOTR", forward: 3000, right: 0 },
      { type: "NEUSTRASH", forward: 1000, right: 2500 },
      { type: "REZKY", forward: 1000, right: -2500 },
    ],
    airWing: [
      { type: "Su-33", count: 4, category: "plane" },
      { type: "Ka-27", count: 2, category: "helicopter" },
    ],
  },
  {
    id: "red-sag",
    description: "Russian surface action group: Moskva cruiser with two frigates in line abreast.",
    side: "red",
    ships: [
      { type: "MOSCOW", forward: 0, right: 0 },
      { type: "NEUSTRASH", forward: 0, right: 1500 },
      { type: "REZKY", forward: 0, right: -1500 },
    ],
  },
  {
    id: "convoy",
    description: "Merchant convoy in two columns: cargo ships and a tanker with a frigate escort.",
    side: "red",
    ships: [
      { type: "REZKY", forward: 0, right: 0 },
      { type: "Dry-cargo ship-1", forward: -1200, right: -500 },
      { type: "Dry-cargo ship-2", forward: -1200, right: 500 },
      { type: "ELNYA", forward: -2400, right: -500 },
      { type: "Dry-cargo ship-1", forward: -2400, right: 500 },
    ],
  },
];

export function findNavalTemplate(id: string): NavalTemplate {
  const hit = NAVAL_TEMPLATES.find((t) => t.id === id.toLowerCase());
  if (!hit) {
    throw new Error(`Unknown naval template '${id}'. Available: ${NAVAL_TEMPLATES.map((t) => t.id).join(", ")}.`);
  }
  return hit;
}


/**
 * Fixed-wing types DCS can operate from a carrier deck. Curated: the unit data
 * has no carrier flag. Helicopters can use any ship with a deck.
 */
export const CARRIER_CAPABLE_PLANES = new Set([
  "FA-18C_hornet",
  "F-14A-135-GR",
  "F-14B",
  "E-2C",
  "S-3B",
  "S-3B Tanker",
  "Su-33",
  "AV8BNA",
]);

export interface AirWingResult {
  groups: { name: string; type: string; count: number }[];
  /** Squadrons left out, and why (e.g. the country is not offered the type). */
  skipped: { type: string; reason: string }[];
  notes: string[];
}

/**
 * Put an air wing on a ship's deck: one aircraft group per squadron, each a
 * ship start linked to the deck ship. Squadrons whose type the Mission Editor
 * does not offer the country are skipped with the reason, never silently
 * swapped for something else.
 */
export function addAirWing(
  mission: LuaTable,
  args: {
    side: Side;
    country: string;
    countryId?: number;
    /** Unit name of the ship the wing operates from. */
    deck: string;
    namePrefix: string;
    squadrons: AirWingSquadron[];
    hot?: boolean;
    skill?: string;
  }
): AirWingResult {
  const result: AirWingResult = { groups: [], skipped: [], notes: [] };
  for (const sq of args.squadrons) {
    const known = findUnitType(sq.type) ?? findModUnit(sq.type);
    if (!known) {
      result.skipped.push({ type: sq.type, reason: "not a DCS type (see dcs_list_unit_types / dcs_list_installed_mods)" });
      continue;
    }
    if (sq.category === "plane" && !CARRIER_CAPABLE_PLANES.has(sq.type)) {
      result.notes.push(`${sq.type} is not on the carrier-capable list; it is placed as asked but may not launch.`);
    }
    const offered = countryOffers(args.country, sq.type);
    if (offered === false) {
      result.skipped.push({ type: sq.type, reason: `the Mission Editor does not offer ${sq.type} to ${args.country}` });
      continue;
    }
    const name = `${args.namePrefix}-${sq.type.replace(/[^A-Za-z0-9]+/g, "")}`;
    addAircraftGroup(mission, sq.category, {
      side: args.side,
      country: args.country,
      countryId: args.countryId,
      name,
      type: sq.type,
      count: sq.count,
      x: 0,
      y: 0,
      skill: args.skill ?? "High",
      start: { kind: args.hot ? "ship_hot" : "ship_cold", ship: args.deck },
    });
    result.groups.push({ name, type: sq.type, count: sq.count });
  }
  return result;
}
