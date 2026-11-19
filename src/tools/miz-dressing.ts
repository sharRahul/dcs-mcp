/**
 * Scene-building tools: FARPs, airfield dressing, static ground-target areas
 * and naval formations.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refresh, requireSession, type MissionSession } from "../miz/sessions.js";
import {
  addAirWing,
  autoAirWing,
  type AirWingResult,
  addFarp,
  addTargetArea,
  findNavalTemplate,
  NAVAL_TEMPLATES,
  populateAirfield,
  TARGET_TEMPLATES,
} from "../miz/dressing.js";
import { addGroundGroup, addTriggerZone } from "../miz/authoring.js";
import { countryOffers } from "../data/reference.js";
import { buildResult, errorResult, render, responseFormatField } from "./format.js";
import { positionFields, resolvePosition } from "./position.js";
import { addRectanglePerimeter, perimeterSpecSchema } from '../miz/perimeter.js';

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
          type: z.string().min(1).max(120).optional()
            .describe("A heliport static the catalogue does not list, by exact id (FARP_SINGLE_01, a mod pad). Needs a learned or mod type source that reports it as a Heliports static; overrides kind."),
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
          kind: a.kind, type: a.type, frequencyMHz: a.frequencyMHz, modulation: a.modulation, callsignId: a.callsignId,
          support: a.support,
        });
        touched(s);
        return buildResult(
          `Added ${a.type ?? a.kind} '${a.name}'` +
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
        ". Legacy sets use a centred grid; staging/base presets use a designed footprint with a central access lane. Both rotate to the heading; each object is its own " +
        "static named <name>-N. zone=true also adds a trigger zone named <name> covering the area. The grid is a " +
        "convention, not copied from an editor mission — check terrain (dcs_check_terrain) and adjust. " +
        "Barracks and the staging/base presets include a rectangular static perimeter and front entrance by default. Set perimeter=false to disable; pass a perimeter object to customize type, nominal segment dimensions, padding and entrance gaps. Other templates opt in explicitly. Scenery does not create operational launchers, pads, guards or supply services; read each template's notes. Perimeter sizes are layout assumptions, not measured collision meshes; approach metadata does not create roads.\n\n" +
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
          perimeter: z.union([z.literal(false),perimeterSpecSchema]).optional(),
        })
        .strict(),
      outputSchema: z.object({ objects: z.array(z.string()), radiusMetres: z.number(), zone: z.string().optional(),perimeter:z.unknown().optional(),
        geometry: z.enum(['designed-footprint', 'generic-grid']), notes: z.array(z.string()) }),
      annotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        const copy = structuredClone(s.mission);
        const r = addTargetArea(copy, {
          side: a.side, country: a.country, countryId: a.countryId, name: a.name, ...pos, heading: a.heading,
          template: a.template, dead: a.dead,perimeter:a.perimeter,
        });
        if (a.zone) addTriggerZone(copy, { name: a.name, ...pos, radius: r.radiusMetres });
        Object.assign(s.mission,copy);
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
    'dcs_miz_add_perimeter',
    {
      title:'Add a static scenery perimeter',
      description:'Create a rotated rectangular boundary from Fortifications static objects around a caller-specified area. Entrances have edge/offset/width and returned inside/outside approach points. Width is across the local right axis; depth is along heading (front). Default Twall_x1 segment span 3 m/depth 0.4 m are explicit scene-layout assumptions, not measured model geometry. Other wall/HESCO/sandbag assets need caller-supplied dimensions and modelHeadingOffsetDegrees as appropriate. No objects scale, no physical roads are created, and live terrain/obstacle/AI-path checks remain necessary. Max 1000 objects. The whole edit rolls back on failure.',
      inputSchema:z.object({sessionId:sessionIdField,...countryFields,name:z.string().min(1).max(48),...positionFields,
        heading:z.number().min(0).max(360).default(0),widthMetres:z.number().min(20).max(2000),depthMetres:z.number().min(20).max(2000),
        ...perimeterSpecSchema.omit({paddingMetres:true}).shape,dead:z.boolean().default(false),
      }).strict(),
      outputSchema:z.object({perimeter:z.unknown()}),annotations,
    },
    async a=>{
      try {
        const s=requireSession(a.sessionId),pos=resolvePosition(s,a);
        const {sessionId:_session,x:_x,y:_y,lat:_lat,lon:_lon,...args}=a;
        const perimeter=addRectanglePerimeter(s.mission,{...args,...pos});
        touched(s);return buildResult(`Added ${perimeter.objects.length} boundary statics with ${perimeter.entrances.length} entrance(s).`,{perimeter});
      }catch(err){return errorResult(err);}
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
        "the wind. The lead ship is <name>-1 — the deck for start.ship.\n\n" +
        "airWing puts aircraft on the lead ship's deck as ship starts, one group per squadron, under the same " +
        "country. 'auto' starts from the template's candidates (csg: F/A-18C, F-14B, E-2C, S-3B tanker, SH-60B; " +
        "lha-group: AV-8B, CH-53E, UH-1H; kuznetsov-group: Su-33, Ka-27) and keeps only types the Mission Editor " +
        "offers the country (pydcs) AND, where the country has a Wikipedia aircraft list, that it currently " +
        "operates — so the retired F-14 and S-3 drop out for the USA. Or pass [{ type, count, category }]. " +
        "Nothing is ever swapped: every dropped squadron is reported with the rule that removed it. Ships the " +
        "country is not offered are reported too.\n\n" +
        "Args: sessionId, side, country, name, template, x/y or lat/lon, heading?, skill?, airWing? ('none'|'auto'|[...]), airWingHot?\n\n" +
        "Returns JSON: { added, ships: [{ name, type }], airWing?: { groups, skipped, notes }, notOffered }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          ...countryFields,
          name: z.string().min(1).max(64),
          template: z.enum(NAVAL_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
          ...positionFields,
          heading: z.number().min(0).max(360).default(0),
          skill: z.enum(["Average", "Good", "High", "Excellent", "Random"]).default("Excellent"),
          airWing: z
            .union([
              z.enum(["none", "auto"]),
              z
                .array(
                  z
                    .object({
                      type: z.string().min(1),
                      count: z.number().int().min(1).max(16),
                      category: z.enum(["plane", "helicopter"]),
                    })
                    .strict()
                )
                .min(1)
                .max(12),
            ])
            .default("none"),
          airWingHot: z.boolean().default(false).describe("Hot (engines running) deck starts"),
        })
        .strict(),
      outputSchema: z.object({
        added: z.string(),
        ships: z.array(z.object({ name: z.string(), type: z.string() })),
        airWing: z
          .object({
            groups: z.array(z.object({ name: z.string(), type: z.string(), count: z.number() })),
            skipped: z.array(z.object({ type: z.string(), reason: z.string() })),
            notes: z.array(z.string()),
          })
          .optional(),
        notOffered: z.array(z.string()),
      }),
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
        const ships = t.ships.map((ship, i) => ({ name: `${a.name}-${i + 1}`, type: ship.type }));
        const notOffered = [...new Set(t.ships.map((x) => x.type))].filter((x) => countryOffers(a.country, x) === false);
        let wing: AirWingResult | undefined;
        let autoNote: string[] = [];
        if (a.airWing !== "none") {
          let squadrons = a.airWing === "auto" ? undefined : a.airWing;
          if (a.airWing === "auto") {
            if (!t.airWing?.length) throw new Error(`Template '${t.id}' has no default air wing; pass airWing as a list.`);
            const auto = autoAirWing(t, a.country);
            squadrons = auto.squadrons;
            autoNote = [
              `Air wing basis: ${auto.basis}.`,
              ...auto.dropped.map((d) => `Left out ${d.type}: ${d.reason}.`),
            ];
          }
          wing = addAirWing(s.mission, {
            side: a.side, country: a.country, countryId: a.countryId, deck: ships[0].name,
            namePrefix: a.name, squadrons: squadrons ?? [], hot: a.airWingHot,
          });
          wing.notes.unshift(...autoNote);
        }
        touched(s);
        const parts = [`Added naval group '${a.name}' (${ships.length} ships).`];
        if (notOffered.length) parts.push(`The Mission Editor does not offer ${notOffered.join(", ")} to ${a.country}.`);
        if (wing) {
          parts.push(`Air wing on ${ships[0].name}: ${wing.groups.map((g) => `${g.count}× ${g.type}`).join(", ") || "none"}.`);
          for (const sk of wing.skipped) parts.push(`Skipped ${sk.type}: ${sk.reason}.`);
          parts.push(...wing.notes);
        }
        return buildResult(parts.join(" "), {
          added: a.name,
          ships,
          ...(wing ? { airWing: wing as unknown as Record<string, unknown> } : {}),
          notOffered,
        } as Record<string, unknown>);
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
      outputSchema: z.object({ targets: z.array(z.record(z.string(), z.unknown())), naval: z.array(z.record(z.string(), z.unknown())) }),
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
