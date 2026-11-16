/**
 * MCP resources (reference material a client can read into context) and
 * prompts (ready-made workflows). Clients that never read CLAUDE.md get the
 * same conventions from here.
 */
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONVENTIONS_GUIDE } from "../guide.js";
import { countries, theatres, unitTypes, type UnitCategory } from "../data/reference.js";
import { allSiteTemplates } from "../miz/templates.js";
import { xyToLatLon } from "../miz/projection.js";

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

const CATEGORIES: UnitCategory[] = ["plane", "helicopter", "vehicle", "ship", "static"];

export function registerResources(server: McpServer): void {
  server.registerResource(
    "conventions",
    "dcs://guide/conventions",
    {
      title: "DCS-MCP conventions",
      description: "Coordinates, headings, SAM sites, triggers, editing safety, live-bridge rules.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: CONVENTIONS_GUIDE }] })
  );

  server.registerResource(
    "countries",
    "dcs://reference/countries",
    { title: "DCS countries", description: "Every DCS country id and name.", mimeType: "application/json" },
    async (uri) => json(uri.href, countries())
  );

  server.registerResource(
    "site-templates",
    "dcs://reference/site-templates",
    {
      title: "SAM site templates",
      description: "Air-defence site compositions with provenance.",
      mimeType: "application/json",
    },
    async (uri) => json(uri.href, allSiteTemplates())
  );

  server.registerResource(
    "unit-types",
    new ResourceTemplate("dcs://reference/unit-types/{category}", {
      list: async () => ({
        resources: CATEGORIES.map((c) => ({
          uri: `dcs://reference/unit-types/${c}`,
          name: `unit-types-${c}`,
          title: `DCS ${c} types`,
          mimeType: "application/json",
        })),
      }),
      complete: { category: (value) => CATEGORIES.filter((c) => c.startsWith(value)) },
    }),
    {
      title: "DCS unit types",
      description: "Exact unit type ids per category (plane, helicopter, vehicle, ship, static).",
      mimeType: "application/json",
    },
    async (uri, { category }) => {
      const c = String(category) as UnitCategory;
      if (!CATEGORIES.includes(c)) throw new Error(`Unknown category '${c}'. Use one of ${CATEGORIES.join(", ")}.`);
      return json(uri.href, unitTypes()[c]);
    }
  );

  server.registerResource(
    "airfields",
    new ResourceTemplate("dcs://theatres/{theatre}/airfields", {
      list: async () => ({
        resources: Object.keys(theatres()).map((t) => ({
          uri: `dcs://theatres/${t}/airfields`,
          name: `airfields-${t}`,
          title: `${t} airfields`,
          mimeType: "application/json",
        })),
      }),
      complete: { theatre: (value) => Object.keys(theatres()).filter((t) => t.toLowerCase().startsWith(value.toLowerCase())) },
    }),
    {
      title: "Theatre airfields",
      description: "Airfield ids, names, positions and parking counts for one theatre.",
      mimeType: "application/json",
    },
    async (uri, { theatre }) => {
      const id = String(theatre);
      const t = theatres()[id];
      if (!t) throw new Error(`Unknown theatre '${id}'. Use one of ${Object.keys(theatres()).join(", ")}.`);
      return json(
        uri.href,
        t.airports.map((a) => ({
          id: a.id,
          name: a.name,
          x: a.x,
          y: a.y,
          ...xyToLatLon(id, a.x, a.y),
          parkingSlots: a.slots.length,
        }))
      );
    }
  );
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "build_mission",
    {
      title: "Build a mission",
      description: "Author a complete mission offline, validate it and save it to a new .miz.",
      argsSchema: {
        theatre: z.string().describe("Theatre, e.g. Caucasus, PersianGulf, Syria"),
        objective: z.string().describe("What the mission is about, e.g. 'SEAD against an SA-6 and SA-2 near Kutaisi'"),
        outPath: z.string().describe("Where to save the .miz"),
      },
    },
    ({ theatre, objective, outPath }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Build a DCS mission on ${theatre}: ${objective}. Save it to ${outPath}.\n\n` +
              `Read dcs://guide/conventions first. Then: dcs_miz_new (theatre ${theatre}) → find exact type ids with ` +
              `dcs_list_unit_types and country names with dcs_list_countries → place things with lat/lon or x/y ` +
              `(x = north) → use dcs_list_site_templates for air defences and dcs_list_airfields for airfield starts → ` +
              `add zones and triggers (dcs_miz_add_trigger_zone, dcs_miz_add_trigger) → frameworks with ` +
              `dcs_miz_load_scripts if needed → dcs_miz_set_mission_options, dcs_miz_set_weather, dcs_miz_set_briefing → ` +
              `dcs_miz_validate and fix every error → dcs_miz_save_as.\n\n` +
              `Report what you could not verify offline (terrain under ground units needs dcs_check_terrain with a ` +
              `mission running).`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "diagnose_mission",
    {
      title: "Diagnose a mission",
      description: "Find out why a mission will not open in the editor, will not load, or misbehaves.",
      argsSchema: { path: z.string().describe("Path to the .miz") },
    },
    ({ path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Diagnose the DCS mission ${path}.\n\n` +
              `1. dcs_status — is DCS up, what phase, and recent log problems.\n` +
              `2. dcs_get_log_errors — the Mission Editor and mission scripts report failures ONLY in dcs.log; ` +
              `look for errors naming the mission or me_mission.lua.\n` +
              `3. dcs_miz_open ${path} → dcs_miz_validate → dcs_miz_list_triggers (uncompiled triggers never fire ` +
              `when flown) → dcs_miz_list_groups.\n` +
              `4. If a mission is running: dcs_check_terrain on ground units' positions (units on water sit inert).\n\n` +
              `Explain the most likely cause first, with the evidence, then what you would change.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "fly_mission",
    {
      title: "Load a mission into DCS",
      description: "Swap a built .miz into a running DCS session and confirm it came up cleanly.",
      argsSchema: { path: z.string().describe("Path to the .miz to load") },
    },
    ({ path }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Load ${path} into DCS and confirm it is running.\n\n` +
              `dcs_bridge_status first: phase must be "running" — dcs_load_mission swaps the mission on an ` +
              `already-running session and cannot start one from the main menu (if DCS is at the menu, ask me to fly ` +
              `any mission first). Then dcs_load_mission, poll dcs_bridge_status until phase goes loading → running, ` +
              `and read dcs_get_log_errors (pass sinceLine from before the load) for anything the load reported.`,
          },
        },
      ],
    })
  );
}
