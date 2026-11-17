/**
 * Tools for learning unit types and their stores from the user's own missions.
 *
 * The bundled catalogue is pinned to pydcs, mod declarations are sometimes in
 * compiled Lua no text scan can read, and a mission can name a mod that is not
 * installed here at all. A Mission-Editor-saved mission settles all three: the
 * type id is there, the category is wherever DCS filed it, and the CLSIDs on its
 * pylons are what that airframe was actually flown with.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  enableLearnedTypes,
  learnedFingerprint,
  learnedTypes,
  learnFromMissions,
  loadLearnedPacks,
  removeLearnedPack,
} from "../dcs/mission-learned.js";
import { findUnitType } from "../data/reference.js";
import { errorResult } from "./format.js";
import { read, result } from "./miz-extended.js";

export function registerLearnedTypeTools(server: McpServer) {
  server.registerTool(
    "dcs_learn_mission_types",
    {
      description:
        "Read a folder of missions YOU supply and report every unit type in them, with the stores each airframe actually carries. This is how to cover three gaps the bundled catalogue cannot: DCS types newer than the pinned pydcs (the carrier deck crew, Oil rig, FARP_SINGLE_01), mods whose type ids live in compiled Lua that no text scan can read (the Su-35 mod registers from encrypted bytecode), and mods that are not installed on this machine but that someone's mission names anyway (Su-30MKI, J-20X, Rafale_C). Pass a name to save it as a pack, which then makes those ids placeable by dcs_miz_add_* after a server restart (or call this with name and then use them in this session). A learned type carries NO catalogue facts - no maximum fuel, no parking footprint, no task list, no pylon validation - so anything needing those treats it as unknown rather than defaulting. 'missions' is the confidence: a type in one mission may be a typo, a type in ten is real. The missions are only read.",
      inputSchema: z
        .object({
          folders: z.array(z.string().min(1).max(1024)).min(1).max(20).describe("Folders of .miz files; searched recursively"),
          name: z.string().min(1).max(48).optional().describe("Save as this pack; omit to scan without saving"),
          includeKnown: z.boolean().default(false).describe("Also report types the bundled catalogue already has"),
          minMissions: z.number().int().min(1).max(100).default(1).describe("Drop types seen in fewer distinct missions than this"),
          overwrite: z.boolean().default(false),
          limit: z.number().int().min(1).max(500).default(60).describe("Types to include in the response"),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const { pack, storedAt, unreadable } = await learnFromMissions(a);
        // Re-register so the ids are usable immediately, not after a restart.
        const enabled = storedAt ? enableLearnedTypes() : undefined;
        const withStores = pack.types.filter((t) => t.stores?.length).length;
        return result({
          missionsRead: pack.sources.length,
          unreadable,
          typesFound: pack.types.length,
          typesWithStores: withStores,
          fingerprint: learnedFingerprint(pack),
          ...(storedAt ? { storedAt, nowPlaceable: enabled?.types } : {}),
          types: pack.types.slice(0, a.limit),
          truncated: pack.types.length > a.limit,
          notes: pack.notes,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_list_learned_types",
    {
      description:
        "Learned type packs stored on this machine, or one type's evidence. Every entry says how many missions it came from, which local mod (if any) declares the same id, and the CLSIDs it was flown with. These are measured from missions, not catalogued: treat them as 'this id exists and this is what it carried', nothing more.",
      inputSchema: z
        .object({
          type: z.string().min(1).max(120).optional().describe("One type id, with its stores and where it was seen"),
          category: z.enum(["plane", "helicopter", "vehicle", "ship", "static"]).optional(),
          withStoresOnly: z.boolean().default(false),
          limit: z.number().int().min(1).max(500).default(80),
        })
        .strict(),
      annotations: read,
    },
    async (a) => {
      try {
        const all = learnedTypes();
        if (a.type) {
          const hit = all.get(a.type);
          if (!hit) {
            const bundled = findUnitType(a.type);
            return result({
              type: a.type,
              learned: false,
              bundled: bundled ? { category: bundled.category, source: bundled.source } : null,
              note: bundled
                ? "Already in the bundled catalogue; nothing was learned for it."
                : "Not learned and not catalogued. Run dcs_learn_mission_types over a folder that contains it.",
            });
          }
          return result({ learned: true, ...hit });
        }
        let types = [...all.values()];
        if (a.category) types = types.filter((t) => t.category === a.category);
        if (a.withStoresOnly) types = types.filter((t) => t.stores?.length);
        const packs = loadLearnedPacks().map((p) => ({
          name: p.name,
          createdAt: p.createdAt,
          missions: p.sources.length,
          types: p.types.length,
          fingerprint: learnedFingerprint(p),
        }));
        return result({
          packs,
          total: types.length,
          types: types
            .sort((x, y) => y.missions - x.missions)
            .slice(0, a.limit)
            .map((t) => ({
              type: t.type,
              category: t.category,
              missions: t.missions,
              units: t.units,
              storeCount: t.stores?.length ?? 0,
              declaredByMod: t.declaredByMod ?? null,
              pack: t.pack,
            })),
          truncated: types.length > a.limit,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_remove_learned_types",
    {
      description: "Delete one learned type pack. The ids in it stop being placeable after the next server start.",
      inputSchema: z.object({ name: z.string().min(1).max(48) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const out = removeLearnedPack(a.name);
        enableLearnedTypes();
        return result(out);
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}
