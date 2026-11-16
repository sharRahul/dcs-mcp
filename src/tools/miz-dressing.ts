/**
 * Scene-building tools: FARPs, airfield dressing, static ground-target areas
 * and naval formations.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refresh, requireSession, type MissionSession } from "../miz/sessions.js";
import {
  addFarp,
  addTargetArea,
  findNavalTemplate,
  NAVAL_TEMPLATES,
  populateAirfield,
  TARGET_TEMPLATES,
} from "../miz/dressing.js";
import { addGroundGroup, addTriggerZone } from "../miz/authoring.js";
import { buildResult, errorResult, render, responseFormatField } from "./format.js";
import { positionFields, resolvePosition } from "./position.js";

const sessionIdField = z.string().min(1).describe("Session id from dcs_miz_open or dcs_miz_new");
const sideField = z.enum(["red", "blue", "neutrals"]).describe("Coalition side");
const countryFields = {
  side: sideField,
  country: z.string().min(1).describe("Exact DCS country name (dcs_list_countries)"),
  countryId: z.number().int().optional(),
};
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function touched(s: MissionSession): void {
  s.dirty = true;
  refresh(s);
}

export function registerMizDressingTools(server: McpServer): void {
  server.registerTool(
    "dcs_miz_add_farp",
    {
      title: "Add FARP / helipad",
      description:
        "Add a FARP (4 pads), single helipad or invisible FARP as a heliport static with its ATC frequency. " +
        "Helicopters (and VTOL jets) can then start from it: dcs_miz_add_aircraft_group with " +
        "start { kind: 'farp_cold'|'farp_hot', farp: <name> }.\n\n" +
        "support=true adds the usual dressing (ammo dump, fuel depot, command bunker, tent, windsock) and a " +
        "support-vehicle group of the same side (fuel truck, ammo truck, command vehicle) — in DCS it is " +
        "nearby friendly support VEHICLES that provide rearm/refuel, not the statics. The layout is a " +
        "convention, not copied from an editor mission.\n\n" +
        "Args: sessionId, side, country, name, x/y or lat/lon, heading?, kind? ('FARP'|'SINGLE_HELIPAD'|'INVISIBLE'), " +
        "frequencyMHz? (127.5), modulation? (0 AM, 1 FM), callsignId?, support?\n\n" +
        "Returns JSON: { farp, statics, supportGroup? }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          ...countryFields,
          name: z.string().min(1).max(64),
          ...positionFields,
          heading: z.number().min(0).max(360).default(0),
          kind: z.enum(["FARP", "SINGLE_HELIPAD", "INVISIBLE"]).default("FARP"),
          frequencyMHz: z.number().min(1).max(400).default(127.5),
          modulation: z.union([z.literal(0), z.literal(1)]).default(0),
          callsignId: z.number().int().min(1).max(100).default(1),
          support: z.boolean().default(false),
        })
        .strict(),
      outputSchema: z.object({ farp: z.string(), statics: z.array(z.string()), supportGroup: z.string().optional() }),
      annotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        const r = addFarp(s.mission, {
          side: a.side, country: a.country, countryId: a.countryId, name: a.name, ...pos, heading: a.heading,
          kind: a.kind, frequencyMHz: a.frequencyMHz, modulation: a.modulation, callsignId: a.callsignId,
          support: a.support,
        });
        touched(s);
        return buildResult(
          `Added ${a.kind} '${a.name}'` +
            (a.support ? ` with ${r.statics.length} support statics${r.supportGroup ? ` and group '${r.supportGroup}'` : ""}` : "") +
            ".",
          { ...r }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_populate_airfield",
    {
      title: "Park statics on an airfield",
      description:
        "Fill an airfield's free parking slots with static objects — parked aircraft, vehicles or equipment — " +
        "so it looks operational or gives a strike something to hit (dead=true parks wrecks). Slot positions " +
        "come from DCS's own airfield data; aircraft go only on slots they fit. Slots used by flights in this " +
        "mission are skipped, and later flights skip these statics. Without heading, each object faces the " +
        "airfield reference point (the parking data has no slot orientation).\n\n" +
        "Args: sessionId, side, country, airfield (name or id), types (list, used in turn), count, namePrefix, " +
        "slots? ('any'|'shelters'|'open'), heading?, dead?\n\n" +
        "Returns JSON: { airfield, placed: [{ name, type, slot }], freeSlotsLeft }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          ...countryFields,
          airfield: z.union([z.string().min(1), z.number().int()]),
          types: z.array(z.string().min(1)).min(1).max(20),
          count: z.number().int().min(1).max(200),
          namePrefix: z.string().min(1).max(48),
          slots: z.enum(["any", "shelters", "open"]).default("any"),
          heading: z.number().min(0).max(360).optional(),
          dead: z.boolean().default(false),
        })
        .strict(),
      outputSchema: z.object({
        airfield: z.string(),
        placed: z.array(z.object({ name: z.string(), type: z.string(), slot: z.string() })),
        freeSlotsLeft: z.number(),
      }),
      annotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const { sessionId: _s, ...args } = a;
        const r = populateAirfield(s.mission, args);
        touched(s);
        const short = r.placed.length < a.count ? ` Only ${r.placed.length} of ${a.count} fit — no more suitable free slots.` : "";
        return buildResult(`Parked ${r.placed.length} static(s) at ${r.airfield}.${short}`, { ...r });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_target_area",
    {
      title: "Add static target area",
      description:
        "Build a ground-target area from static objects: " +
        TARGET_TEMPLATES.map((t) => `'${t.id}' (${t.description})`).join("; ") +
        ". Objects are laid out in a grid centred on the position and rotated to the heading; each is its own " +
        "static named <name>-N. zone=true also adds a trigger zone named <name> covering the area. The grid is a " +
        "convention, not copied from an editor mission — check terrain (dcs_check_terrain) and adjust.\n\n" +
        "Args: sessionId, side, country, name, template, x/y or lat/lon, heading?, zone?, dead?\n\n" +
        "Returns JSON: { objects, radiusMetres, zone? }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          ...countryFields,
          name: z.string().min(1).max(48),
          template: z.enum(TARGET_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
          ...positionFields,
          heading: z.number().min(0).max(360).default(0),
          zone: z.boolean().default(false),
          dead: z.boolean().default(false),
        })
        .strict(),
      outputSchema: z.object({ objects: z.array(z.string()), radiusMetres: z.number(), zone: z.string().optional() }),
      annotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        const r = addTargetArea(s.mission, {
          side: a.side, country: a.country, countryId: a.countryId, name: a.name, ...pos, heading: a.heading,
          template: a.template, dead: a.dead,
        });
        if (a.zone) addTriggerZone(s.mission, { name: a.name, ...pos, radius: r.radiusMetres });
        touched(s);
        return buildResult(
          `Added ${a.template} '${a.name}': ${r.objects.length} objects within ${r.radiusMetres} m` +
            (a.zone ? `, zone '${a.name}'.` : "."),
          { ...r, ...(a.zone ? { zone: a.name } : {}) }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_naval_group",
    {
      title: "Add naval formation",
      description:
        "Add a ship formation as one group with each ship on its station relative to the lead: " +
        NAVAL_TEMPLATES.map((t) => `'${t.id}' (${t.description})`).join("; ") +
        ". Stations are a conventional screen (kilometres apart), not copied from an editor mission. Add " +
        "waypoints with dcs_miz_add_waypoint to get it moving; a carrier recovering aircraft should steam into " +
        "the wind. Carrier unit names are <name>-1 — use that as start.ship for deck starts.\n\n" +
        "Args: sessionId, side, country, name, template, x/y or lat/lon, heading?, skill?\n\n" +
        "Returns JSON: { added, ships: [{ name, type }] }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          ...countryFields,
          name: z.string().min(1).max(64),
          template: z.enum(NAVAL_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
          ...positionFields,
          heading: z.number().min(0).max(360).default(0),
          skill: z.enum(["Average", "Good", "High", "Excellent", "Random"]).default("Excellent"),
        })
        .strict(),
      outputSchema: z.object({ added: z.string(), ships: z.array(z.object({ name: z.string(), type: z.string() })) }),
      annotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        const t = findNavalTemplate(a.template);
        addGroundGroup(s.mission, "ship", {
          side: a.side, country: a.country, countryId: a.countryId, name: a.name,
          type: t.ships[0].type, count: t.ships.length,
          composition: t.ships.map((ship) => ({ type: ship.type, count: 1 })),
          offsets: t.ships.map(({ forward, right }) => ({ forward, right })),
          ...pos, heading: a.heading, skill: a.skill,
        });
        touched(s);
        const ships = t.ships.map((ship, i) => ({ name: `${a.name}-${i + 1}`, type: ship.type }));
        return buildResult(`Added naval group '${a.name}' (${ships.length} ships).`, { added: a.name, ships });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_list_scene_templates",
    {
      title: "List target and naval templates",
      description:
        "Static target-area templates (dcs_miz_add_target_area) and naval formations (dcs_miz_add_naval_group), " +
        "with their contents. SAM sites are in dcs_list_site_templates.\n\nReturns JSON: { targets, naval }.",
      inputSchema: z.object({ response_format: responseFormatField }).strict(),
      outputSchema: z.object({ targets: z.array(z.record(z.unknown())), naval: z.array(z.record(z.unknown())) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) =>
      render(
        a.response_format,
        () =>
          [
            "# Target areas",
            ...TARGET_TEMPLATES.map((t) => `- **${t.id}**: ${t.objects.map((o) => `${o.count}× \`${o.type}\``).join(", ")}`),
            "",
            "# Naval formations",
            ...NAVAL_TEMPLATES.map((t) => `- **${t.id}** (${t.side}): ${t.ships.map((sh) => `\`${sh.type}\``).join(", ")}`),
          ].join("\n"),
        {
          targets: TARGET_TEMPLATES as unknown as Record<string, unknown>[],
          naval: NAVAL_TEMPLATES as unknown as Record<string, unknown>[],
        }
      )
  );
}
