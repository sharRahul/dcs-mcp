/**
 * Offline reference tools: unit types, countries, airfields, site templates and
 * coordinate conversion. They need no session and no running DCS.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  countries,
  findAirport,
  resolveTheatreName,
  SLOT_AIRPLANES,
  SLOT_HELI,
  SLOT_LARGE,
  SLOT_SHELTER,
  theatre as theatreData,
  theatres,
} from "../data/reference.js";
import { searchUnitTypes } from "../miz/editing.js";
import { latLonToXY, xyToLatLon } from "../miz/projection.js";
import { allSiteTemplates } from "../miz/templates.js";
import { countryInventory, type InventoryRow } from "../miz/inventory.js";
import { installedMods, modRoots } from "../dcs/mods.js";
import { buildResult, errorResult, render, responseFormatField } from "./format.js";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const theatreField = z
  .string()
  .min(1)
  .describe("Theatre, e.g. 'Caucasus', 'PersianGulf', 'Syria', 'Nevada', 'MarianaIslands', 'SinaiMap'");

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "dcs_list_unit_types",
    {
      title: "Find unit types",
      description:
        "Search the bundled DCS unit catalogue — plus unit mods installed on this machine — for exact type " +
        "ids, the strings dcs_miz_add_* need. country= narrows to what the Mission Editor offers that country " +
        "(DCS's own, permissive list; for what it really operates use dcs_country_inventory). " +
        "Every word of the query must match the type id, display name or family (e.g. 'sa-11', " +
        "'hornet', 'abrams', 'farp', 'cargo'). Aircraft entries include their supported tasks. Types added " +
        "by newer DCS versions or mods may be missing; those still work, but the validator warns.\n\n" +
        "Args: category? ('plane'|'helicopter'|'vehicle'|'ship'|'static'), query?, country?, includeMods? (default true), limit? (default 50)\n\n" +
        "Returns JSON: { count, types: [{ category, type, name?, group?, tasks?, source ('dcs' | 'mod:<id>') }] }.",
      inputSchema: z
        .object({
          category: z.enum(["plane", "helicopter", "vehicle", "ship", "static"]).optional(),
          query: z.string().max(100).optional(),
          country: z.string().min(1).optional().describe("Only types the Mission Editor offers this country"),
          includeMods: z.boolean().default(true).describe("Include unit mods installed on this machine"),
          limit: z.number().int().min(1).max(500).default(50),
          response_format: responseFormatField,
        })
        .strict(),
      outputSchema: z.object({ count: z.number(), types: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) => {
      let types;
      try {
        types = searchUnitTypes(a.category, a.query, a.limit, { country: a.country, includeMods: a.includeMods });
      } catch (err) {
        return errorResult(err);
      }
      return render(
        a.response_format,
        () =>
          types.length
            ? [
                `# Unit types (${types.length}${types.length === a.limit ? "+, raise limit for more" : ""})`,
                "",
                ...types.map(
                  (t) =>
                    `- \`${t.type}\` (${t.category}${t.group ? `/${t.group}` : ""}${t.source !== "dcs" ? `, ${t.source}` : ""})` +
                    `${t.name && t.name !== t.type ? ` — ${t.name}` : ""}` +
                    `${t.tasks?.length ? ` — tasks: ${t.tasks.join(", ")}` : ""}`
                ),
              ].join("\n")
            : "No matching unit types.",
        { count: types.length, types }
      );
    }
  );

  server.registerTool(
    "dcs_list_countries",
    {
      title: "List countries",
      description:
        "Every DCS country with its id, exactly as a mission stores it. Use the exact name in " +
        "dcs_miz_add_*. A country belongs to one coalition per mission; the 'Combined Joint Task Forces " +
        "Blue/Red' countries exist for mixed-equipment sides.\n\nArgs: query?\n\n" +
        "Returns JSON: { count, countries: [{ id, name, short }] }.",
      inputSchema: z.object({ query: z.string().max(60).optional(), response_format: responseFormatField }).strict(),
      outputSchema: z.object({ count: z.number(), countries: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) => {
      const q = a.query?.toLowerCase();
      const list = countries().filter(
        (c) => !q || c.name.toLowerCase().includes(q) || c.short.toLowerCase().includes(q)
      );
      return render(
        a.response_format,
        () => list.map((c) => `- ${c.id}: ${c.name} (${c.short})`).join("\n") || "No match.",
        { count: list.length, countries: list as unknown as Record<string, unknown>[] }
      );
    }
  );

  server.registerTool(
    "dcs_list_airfields",
    {
      title: "List airfields",
      description:
        "Airfields on a theatre with id, position and parking capacity (aeroplane / helicopter / large / " +
        "shelter slots). Pass airfield to get one airfield's individual parking slots — the names " +
        "dcs_miz_add_aircraft_group accepts in start.parking.\n\n" +
        "Args: theatre, query? (name filter), airfield? (name or id: list its slots)\n\n" +
        "Returns JSON: { theatre, count, airfields: [{ id, name, x, y, lat, lon, slots: { total, airplanes, " +
        "helicopters, large, shelters } }], parking?: [{ name, x, y, airplanes, helicopters, large, shelter, widthMetres }] }.",
      inputSchema: z
        .object({
          theatre: theatreField,
          query: z.string().max(60).optional(),
          airfield: z.union([z.string().min(1), z.number().int()]).optional(),
          response_format: responseFormatField,
        })
        .strict(),
      outputSchema: z.object({
        theatre: z.string(),
        count: z.number(),
        airfields: z.array(z.record(z.string(), z.unknown())),
        parking: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const id = resolveTheatreName(a.theatre);
        const t = theatreData(a.theatre);
        const summarize = (ap: (typeof t.airports)[number]) => {
          const ll = xyToLatLon(id as string, ap.x, ap.y);
          const count = (flag: number) => ap.slots.filter((s) => (s[4] & flag) !== 0).length;
          return {
            id: ap.id,
            name: ap.name,
            x: ap.x,
            y: ap.y,
            lat: Number(ll.lat.toFixed(5)),
            lon: Number(ll.lon.toFixed(5)),
            slots: {
              total: ap.slots.length,
              airplanes: count(SLOT_AIRPLANES),
              helicopters: count(SLOT_HELI),
              large: count(SLOT_LARGE),
              shelters: count(SLOT_SHELTER),
            },
          };
        };
        if (a.airfield !== undefined) {
          const ap = findAirport(id as string, a.airfield);
          const parking = ap.slots.map((s) => ({
            name: s[1],
            x: s[2],
            y: s[3],
            airplanes: (s[4] & SLOT_AIRPLANES) !== 0,
            helicopters: (s[4] & SLOT_HELI) !== 0,
            large: (s[4] & SLOT_LARGE) !== 0,
            shelter: (s[4] & SLOT_SHELTER) !== 0,
            widthMetres: s[5],
          }));
          const summary = summarize(ap);
          return render(
            a.response_format,
            () =>
              [
                `# ${ap.name} (id ${ap.id}, ${id}) — ${parking.length} parking slots`,
                "",
                ...parking.map(
                  (p) =>
                    `- ${p.name}: ${[p.airplanes && "aeroplane", p.helicopters && "heli", p.large && "large", p.shelter && "shelter"]
                      .filter(Boolean)
                      .join(", ")} (${p.widthMetres} m wide)`
                ),
              ].join("\n"),
            { theatre: id as string, count: 1, airfields: [summary], parking }
          );
        }
        const q = a.query?.toLowerCase();
        const list = t.airports.filter((ap) => !q || ap.name.toLowerCase().includes(q)).map(summarize);
        return render(
          a.response_format,
          () =>
            [
              `# Airfields on ${id} (${list.length})`,
              "",
              ...list.map(
                (ap) =>
                  `- **${ap.name}** (id ${ap.id}) ${ap.lat}, ${ap.lon} — ${ap.slots.airplanes} aeroplane / ` +
                  `${ap.slots.helicopters} heli slots`
              ),
            ].join("\n"),
          { theatre: id as string, count: list.length, airfields: list }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_list_site_templates",
    {
      title: "List SAM site templates",
      description:
        "Air-defence site templates for dcs_miz_add_ground_group's `site` argument: the unit mix that makes " +
        "a site actually engage (radars + launchers in ONE group). Each states its provenance: 'engaged' " +
        "(fought in a live sortie), 'me-saved' (copied from a Mission-Editor mission), 'loaded' (flown and " +
        "registered with Skynet, never engaged), 'catalogue' (types exist in DCS; this exact layout not " +
        "yet flown), or 'imported' (copied with its exact layout from a mission you supplied via dcs_import_site_template).\n\nReturns JSON: { templates: [{ id, description, provenance, composition, spacingMetres, skynetRole }] }.",
      inputSchema: z.object({ response_format: responseFormatField }).strict(),
      outputSchema: z.object({ templates: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) =>
      render(
        a.response_format,
        () =>
          allSiteTemplates().map(
            (t) =>
              `- **${t.id}** [${t.provenance}] ${t.description}\n  ` +
              t.composition.map((c) => `${c.count}× \`${c.type}\``).join(", ")
          ).join("\n"),
        { templates: allSiteTemplates() as unknown as Record<string, unknown>[] }
      )
  );

  server.registerTool(
    "dcs_geo_convert",
    {
      title: "Convert coordinates (offline)",
      description:
        "Convert between WGS84 lat/lon and DCS map x/y (x = metres NORTH, y = metres EAST) for a theatre, " +
        "without DCS running, using the theatre's transverse-Mercator constants. Give lat+lon or x+y. " +
        "For a placement that matters, cross-check once with the live dcs_convert_coords.\n\n" +
        `Supported theatres: ${Object.keys(theatres()).join(", ")}.\n\n` +
        "Args: theatre, lat+lon OR x+y\n\nReturns JSON: { theatre, lat, lon, x, y }.",
      inputSchema: z
        .object({
          theatre: theatreField,
          lat: z.number().min(-90).max(90).optional(),
          lon: z.number().min(-180).max(180).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })
        .strict(),
      outputSchema: z.object({ theatre: z.string(), lat: z.number(), lon: z.number(), x: z.number(), y: z.number() }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const id = resolveTheatreName(a.theatre);
        if (!id) theatreData(a.theatre); // throws with the supported list
        let out: { lat: number; lon: number; x: number; y: number };
        if (a.lat !== undefined && a.lon !== undefined && a.x === undefined && a.y === undefined) {
          out = { lat: a.lat, lon: a.lon, ...latLonToXY(id as string, a.lat, a.lon) };
        } else if (a.x !== undefined && a.y !== undefined && a.lat === undefined && a.lon === undefined) {
          out = { x: a.x, y: a.y, ...xyToLatLon(id as string, a.x, a.y) };
        } else {
          throw new Error("Give exactly one pair: lat+lon, or x+y.");
        }
        return buildResult(
          `${id}: lat ${out.lat.toFixed(6)}, lon ${out.lon.toFixed(6)} = x ${out.x.toFixed(1)} (north), ` +
            `y ${out.y.toFixed(1)} (east)`,
          { theatre: id as string, ...out }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_country_inventory",
    {
      title: "Country inventory (real world vs DCS)",
      description:
        "What a country actually operates — aircraft, ground forces, ships, from Wikipedia's equipment lists — " +
        "set against what DCS can place for it. Each real-world type is marked:\n" +
        "  - dcs-for-country: a DCS type exists and the Mission Editor offers it to this country,\n" +
        "  - dcs-other-country: DCS has the type, but not for this country (use a Combined Joint Task Forces " +
        "country, or accept the validator warning),\n" +
        "  - mod: DCS lacks it, but a unit mod installed on this machine matches (e.g. a community Su-30MKI),\n" +
        "  - missing: nothing in DCS or the installed mods.\n" +
        "No guessing: a row matches a DCS type only when a designation or name appears literally in both the " +
        "Wikipedia row and the pydcs type. `exact` = same full designation (C-17A); otherwise a family match " +
        "(Su-30MKI ~ Su-30: a different variant). Mods are an addition: they are listed alongside, never instead of, DCS types. " +
        "Wikipedia lists are a snapshot (see `generated`); they can lag or lead real service status.\n\n" +
        "Args: country, kind? ('aircraft'|'ground'|'naval'), availability? (filter)\n\n" +
        "Returns JSON: { country, generated, pages, offeredCounts, rows: [{ kind, name, wiki, availability, dcs, dcsForCountry, mods }] }.",
      inputSchema: z
        .object({
          country: z.string().min(1),
          kind: z.enum(["aircraft", "ground", "naval"]).optional(),
          availability: z.enum(["dcs-for-country", "dcs-other-country", "mod", "missing"]).optional(),
          response_format: responseFormatField,
        })
        .strict(),
      outputSchema: z.object({
        country: z.string(),
        generated: z.string(),
        pages: z.record(z.string(), z.string()),
        offeredCounts: z.record(z.string(), z.number()),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const inv = countryInventory(a.country);
        const kinds = a.kind ? [a.kind] : (["aircraft", "ground", "naval"] as const);
        const rows: (InventoryRow & { kind: string })[] = [];
        for (const kind of kinds) {
          for (const row of inv[kind]) {
            if (!a.availability || row.availability === a.availability) rows.push({ ...row, kind });
          }
        }
        const label = (r: InventoryRow) =>
          (r.availability === "dcs-for-country"
            ? `DCS: ${r.dcsForCountry.map((t) => (r.exact.includes(t) ? t : `${t} (family)`)).join(", ")}`
            : r.availability === "dcs-other-country"
              ? `DCS (not offered to ${inv.country}): ${r.dcs.join(", ")}`
              : r.availability === "mod"
                ? `installed mod: ${r.mods.map((m) => `${m.type} (${m.mod})`).join(", ")}`
                : "not in DCS or installed mods") +
          (r.availability !== "mod" && r.mods.length
            ? `; also installed mod: ${r.mods.map((m) => `${m.type} (${m.mod})`).join(", ")}`
            : "");
        return render(
          a.response_format,
          () =>
            [
              `# ${inv.country}: real-world inventory vs DCS (Wikipedia snapshot ${inv.generated})`,
              ...kinds.flatMap((kind) => [
                "",
                `## ${kind}${inv.pages[kind] ? ` — from "${inv.pages[kind]}"` : " — no Wikipedia list found"}`,
                ...rows.filter((r) => r.kind === kind).map((r) => `- ${r.name}: ${label(r)}`),
              ]),
            ].join("\n"),
          {
            country: inv.country,
            generated: inv.generated,
            pages: inv.pages as Record<string, string>,
            offeredCounts: inv.offeredCounts,
            rows: rows as unknown as Record<string, unknown>[],
          }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_list_installed_mods",
    {
      title: "List installed unit mods",
      description:
        "Unit mods installed on this machine: Saved Games/DCS*/Mods/{aircraft,tech} and the DCS install's " +
        "Mods (set DCS_INSTALL_DIR if DCS is not under Program Files/Eagle Dynamics). Mod files are scanned " +
        "as text for unit declarations (make_flyable, add_aircraft Name, GT.Name) — never executed — so a " +
        "mod that builds names in code may be missed. Types found here can be used in dcs_miz_add_* and the " +
        "validator accepts them.\n\nArgs: refresh? (rescan now)\n\n" +
        "Returns JSON: { roots, mods: [{ id, folder, kind, units: [{ type, category, file }] }] }.",
      inputSchema: z.object({ refresh: z.boolean().default(false), response_format: responseFormatField }).strict(),
      outputSchema: z.object({ roots: z.array(z.string()), mods: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const roots = modRoots();
        const mods = installedMods(a.refresh);
        return render(
          a.response_format,
          () =>
            roots.length === 0
              ? "No DCS Saved Games or install folder found on this machine (set DCS_SAVED_GAMES / DCS_INSTALL_DIR)."
              : mods.length === 0
                ? `No unit mods found under:\n${roots.map((r) => `- ${r}`).join("\n")}`
                : mods
                    .map(
                      (m) =>
                        `- **${m.id}** (${m.kind}, ${m.folder}): ` +
                        m.units.map((u) => `\`${u.type}\` (${u.category})`).join(", ")
                    )
                    .join("\n"),
          { roots, mods: mods as unknown as Record<string, unknown>[] }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
