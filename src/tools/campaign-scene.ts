/**
 * Tools for things that live outside a single `.miz`: DCS campaign files, and
 * compound footprints imported from a mission the user supplies.
 *
 * Both are offline. The campaign format and its progression rules come from ED's
 * own installed campaign code read as text; the footprints are measured from the
 * user's own missions. Neither has been run by DCS from a file this project
 * wrote, and the tool text says so rather than implying otherwise.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import {
  campaignSpecSchema,
  checkCampaignFiles,
  playerUnitType,
  readCampaignFile,
  stepCampaign,
  validateCampaign,
  writeCampaignFile,
} from "../dcs/campaign.js";
import { readMizArchive } from "../miz/archive.js";
import { parseLuaAssignment } from "../miz/lua.js";
import {
  importSceneTemplate,
  loadSceneTemplates,
  removeSceneTemplate,
  findSceneTemplate,
  sceneFingerprint,
  scanSceneCandidates,
} from "../miz/scene-import.js";
import { addSceneTemplate } from "../miz/dressing.js";
import { addTriggerZone } from "../miz/authoring.js";
import { addDepartureComms, departureCommsSchema } from "../miz/departure-comms.js";
import { addReactiveSpawn, reactiveSpawnSchema, setDynamicSpawnTemplate } from "../miz/reactive.js";
import { errorResult } from "./format.js";
import { mutate, read, result, sessionId, writes } from "./miz-extended.js";

const fileField = z.string().min(1).max(1024);

/** Theatre and player unit type per mission, for campaign checks. */
async function missionFacts(directory: string, files: string[]) {
  const theatres: Record<string, string> = {};
  const units: string[] = [];
  for (const file of new Set(files)) {
    try {
      const archive = await readMizArchive(path.join(directory, file));
      const text = archive.entries.get("mission");
      if (!text) continue;
      const mission = parseLuaAssignment(text, "mission");
      if (typeof mission["theatre"] === "string") theatres[file] = mission["theatre"];
      const type = playerUnitType(mission);
      if (type) units.push(type);
    } catch {
      // A mission that cannot be read is reported by checkCampaignFiles instead.
    }
  }
  return { theatres, units: [...new Set(units)] };
}

export function registerCampaignSceneTools(server: McpServer) {
  // -------------------------------------------------------------------------
  // Campaign files (.cmp)
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_campaign_read",
    {
      description:
        "Read a DCS campaign file (.cmp) as data and validate it. A .cmp is a plain Lua chunk assigning one `campaign` table, not an archive; it is parsed, never executed. Returns the stages in ladder order with each mission's score interval, the modules it needs, which mission files are present beside it, and findings. An error finding means DCS refuses the campaign (empty stage, missing mission file) or dead-ends inside it (a score no mission in the next stage covers).",
      inputSchema: z.object({ file: fileField, expand: z.boolean().default(false).describe("Include every mission entry, not just the counts") }).strict(),
      annotations: read,
    },
    async (a) => {
      try {
        const { campaign, sha256, localisedKeys } = await readCampaignFile(a.file);
        const directory = path.dirname(path.resolve(a.file));
        const files = await checkCampaignFiles(campaign, directory);
        const facts = await missionFacts(
          directory,
          campaign.stages.flatMap((s) => s.missions.map((m) => m.file))
        );
        const report = validateCampaign(campaign, { directory, theatres: facts.theatres });
        return result({
          name: campaign.name,
          sha256,
          startStage: campaign.startStage,
          stages: report.stages,
          missions: report.missions,
          necessaryUnits: campaign.necessaryUnits ?? {},
          playerUnitTypes: facts.units,
          theatres: [...new Set(Object.values(facts.theatres))],
          missingMissions: files.missing,
          localisedKeys,
          findings: report.findings,
          ...(a.expand
            ? {
                ladder: campaign.stages.map((s, i) => ({
                  stage: i + 1,
                  name: s.name,
                  missions: s.missions.map((m) => ({ file: m.file, interval: m.interval, skipScore: m.skipScore })),
                })),
              }
            : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_campaign_write",
    {
      description:
        "Write a DCS campaign file (.cmp) for missions that already sit in the output folder. Stages are a ladder: after a mission DCS moves up a stage on a score above 50, repeats the stage on exactly 50 and moves down below 50, then picks at random among that stage's missions whose interval contains the score (ED's own chooseNextMission). Every stage therefore needs missions covering 0-100 or the campaign stops with 'no mission chosen', and the start stage wants at least one mission whose interval ends at 100. Mission files are NOT copied: DCS resolves each one as <campaign folder>/<file>. necessaryUnits is derived from each mission's player aircraft unless given. Refuses to write a campaign DCS could not run. Offline: no campaign written here has been run by DCS yet.",
      inputSchema: z
        .object({ outPath: fileField.describe("Path ending in .cmp, in the folder that holds the missions"), campaign: campaignSpecSchema, overwrite: z.boolean().default(false) })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const directory = path.dirname(path.resolve(a.outPath));
        const parsed = campaignSpecSchema.parse(a.campaign);
        const facts = await missionFacts(
          directory,
          parsed.stages.flatMap((s) => s.missions.map((m) => m.file))
        );
        const written = await writeCampaignFile(a.outPath, a.campaign, {
          overwrite: a.overwrite,
          directory,
          necessaryUnits: facts.units,
        });
        return result({ ...written, derivedNecessaryUnits: facts.units, theatres: [...new Set(Object.values(facts.theatres))] });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_campaign_step",
    {
      description:
        "Where a campaign goes after a mission, by ED's own rule: score above 50 (or a skipped mission) advances a stage, exactly 50 repeats it, below 50 retreats, past the last stage is a win and below stage 1 is a loss. Returns every mission in the destination stage whose interval contains the score - DCS picks one of them at random, so they are all returned rather than one being chosen here. Use it to walk a campaign's branches before flying it.",
      inputSchema: z
        .object({ file: fileField, stage: z.number().int().positive(), result: z.number().min(0).max(100), skipped: z.boolean().default(false) })
        .strict(),
      annotations: read,
    },
    async (a) => {
      try {
        const { campaign } = await readCampaignFile(a.file);
        return result({ ...stepCampaign(campaign, { stage: a.stage, result: a.result, skipped: a.skipped }) });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Compound footprints
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_scan_scene_candidates",
    {
      description:
        "Find static compounds in a mission YOU supply: statics are clustered by proximity (single linkage at linkMetres), and each cluster is reported with its type mix, radius, the cluster's own heading and how many distinct object headings it contains. distinctHeadings=1 means a block someone placed on a grid; a higher number means a real footprint with its props turned individually. Nothing is written and nothing is read from the mission but the statics. A cluster is not a purpose: the type mix is what the file says, and no intent is inferred from it. Pick one by index and import it with dcs_import_scene_template using the same settings.",
      inputSchema: z
        .object({
          file: fileField,
          linkMetres: z.number().min(1).max(2000).default(60),
          minObjects: z.number().int().min(2).max(200).default(4),
          maxObjects: z.number().int().min(2).max(500).default(80),
          side: z.enum(["red", "blue", "neutrals"]).optional(),
          expand: z.boolean().default(false).describe("Include every object's offsets, not just the summary"),
        })
        .strict(),
      annotations: read,
    },
    async (a) => {
      try {
        const scan = await scanSceneCandidates(a);
        return result({
          ...scan,
          candidates: scan.candidates.map((c) => ({
            index: c.index,
            count: c.count,
            typeCounts: c.typeCounts,
            radiusMetres: c.radiusMetres,
            headingDegrees: c.headingDegrees,
            distinctHeadings: c.distinctHeadings,
            side: c.side,
            country: c.country,
            groups: c.groups,
            centre: c.centre,
            ...(a.expand ? { objects: c.objects } : {}),
          })),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_import_scene_template",
    {
      description:
        "Import one static compound from a mission YOU supply as a reusable footprint: every object's exact offset along and right of the compound's own heading, plus its individual heading offset, so placing it elsewhere reproduces the layout instead of re-laying it on a grid. Run dcs_scan_scene_candidates first with the SAME settings and pass the candidate index. Provenance is 'imported' - weaker than any built-in template: this project has not flown it or opened it in the Mission Editor, and cannot prove the source was editor-saved. Stored under DCS_MCP_TEMPLATE_DIR or the user data folder; the source mission is only read, and nothing is shipped with this server.",
      inputSchema: z
        .object({
          file: fileField,
          candidate: z.number().int().positive(),
          id: z.string().min(1).max(48),
          description: z.string().max(300).optional(),
          linkMetres: z.number().min(1).max(2000).default(60),
          minObjects: z.number().int().min(2).max(200).default(4),
          maxObjects: z.number().int().min(2).max(500).default(80),
          side: z.enum(["red", "blue", "neutrals"]).optional(),
          overwrite: z.boolean().default(false),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      try {
        const { template, path: file } = await importSceneTemplate(a);
        return result({
          id: template.id,
          description: template.description,
          objects: template.objects.length,
          radiusMetres: template.radiusMetres,
          typeCounts: template.typeCounts,
          distinctHeadings: new Set(template.objects.map((o) => o.headingOffset)).size,
          fingerprint: sceneFingerprint(template),
          provenance: template.provenance,
          source: template.source,
          storedAt: file,
          notes: template.notes,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_list_scene_imports",
    {
      description:
        "Imported compound footprints on this machine (dcs_import_scene_template), with their type mix, radius, source file and fingerprint. All provenance 'imported': measured from a user-supplied mission, never flown or opened in the Mission Editor by this project.",
      inputSchema: z.object({ id: z.string().min(1).max(48).optional().describe("One template, expanded to its objects") }).strict(),
      annotations: read,
    },
    async (a) => {
      try {
        if (a.id) {
          const template = findSceneTemplate(a.id);
          return result({ ...template, fingerprint: sceneFingerprint(template) });
        }
        const templates = loadSceneTemplates();
        return result({
          count: templates.length,
          templates: templates.map((t) => ({
            id: t.id,
            description: t.description,
            objects: t.objects.length,
            radiusMetres: t.radiusMetres,
            typeCounts: t.typeCounts,
            provenance: t.provenance,
            source: t.source,
            fingerprint: sceneFingerprint(t),
          })),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_remove_scene_template",
    {
      description: "Delete one imported compound footprint.",
      inputSchema: z.object({ id: z.string().min(1).max(48) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        return result(removeSceneTemplate(a.id));
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_scene",
    {
      description:
        "Place an imported compound footprint (dcs_list_scene_imports) at a position and heading. Each object keeps the exact offset and individual heading it had in the source, so a walled outpost or a revetted park comes out as it was built rather than re-laid on a grid - that is the difference from dcs_miz_add_target_area, whose grid is this project's own convention. zone=true also adds a trigger zone covering the footprint. Terrain is not checked: use dcs_check_terrain (needs a running mission) before trusting the ground under it.",
      inputSchema: z
        .object({
          sessionId,
          template: z.string().min(1).max(48),
          side: z.enum(["red", "blue", "neutrals"]),
          country: z.string().min(1),
          countryId: z.number().int().optional(),
          name: z.string().min(1).max(48),
          x: z.number().finite(),
          y: z.number().finite(),
          heading: z.number().min(0).max(360).default(0),
          zone: z.boolean().default(false),
          dead: z.boolean().default(false).describe("Place every object as a wreck, whatever the source had"),
        })
        .strict(),
      annotations: writes,
    },
    async (a) =>
      mutate(a.sessionId, (s) => {
        const template = findSceneTemplate(a.template);
        const placed = addSceneTemplate(s.mission, template, {
          side: a.side,
          country: a.country,
          countryId: a.countryId,
          name: a.name,
          x: a.x,
          y: a.y,
          heading: a.heading,
          dead: a.dead || undefined,
        });
        if (a.zone) addTriggerZone(s.mission, { name: a.name, x: a.x, y: a.y, radius: template.radiusMetres });
        return { ...placed, ...(a.zone ? { zone: a.name } : {}) };
      })
  );

  // -------------------------------------------------------------------------
  // Reactive ("dynamic") spawns
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_miz_add_reactive_spawn",
    {
      description:
        "Wire a reserve that appears during the mission: a trigger that activates late-activated groups when the player enters a zone, a group dies or is hurt, a flag is set or a time passes - optionally with a percentage chance, a delay, a message, an AI task push and a flag of its own. This is how community 'dynamic' missions are built (a_activate_group is the most used action in the mission corpus, on late-activated groups), and every predicate it writes has a recorded Mission-Editor spec-to-Lua pair, so the trigger fires when the mission is flown directly. Groups to activate must already exist with lateActivation=true, or activating them would do nothing. A delay costs one flag, because DCS has no delay on a_activate_group. For ED's Dynamic Slots see dcs_miz_set_dynamic_spawn.",
      inputSchema: z.object({ sessionId, spawn: reactiveSpawnSchema }).strict(),
      annotations: writes,
    },
    async (a) => mutate(a.sessionId, (s) => ({ ...addReactiveSpawn(s.mission, a.spawn, s.dictionary) }))
  );

  server.registerTool(
    "dcs_miz_add_departure_comms",
    {
      description:
        "Script the player's departure from an airfield: mission briefing message (and sound) at start, then an F10-menu driven exchange - request startup, request taxi, ready for departure - each with the pilot's call and the controller's reply (runway, ATC UHF/VHF from pydcs), an automatic airborne call and handoff to AWACS once the lead is above departureAGLMetres, and an AWACS check-in whose reply gives the next action (awacs.tasking). Optional holdShortZone prompts the tower call automatically. Every line goes to the player group; pass audio.<step> resource keys (dcs_audio_convert + embed) to play a sound with each line, otherwise lines are text only. Uses only oracle-backed predicates. Dialogue is fictional brevity-style, not authenticated procedure; DCS's own ATC is not replaced. The group must start at an airfield. Offline only; not flown.",
      inputSchema: z.object({ sessionId, comms: departureCommsSchema }).strict(),
      annotations: writes,
    },
    async (a) => mutate(a.sessionId, (s) => ({ ...addDepartureComms(s.mission, a.comms, s.dictionary) }))
  );

  server.registerTool(
    "dcs_miz_set_dynamic_spawn",
    {
      description:
        "Set a flying group's dynSpawnTemplate flag, which is what the editor writes for ED's Dynamic Slots. The field is real and the editor writes it on every plane and helicopter group, but every editor-saved mission available to this project carries it as false, so a true value has not been seen, flown or verified here - nothing else about the feature is claimed. For reserves that appear during a mission, use dcs_miz_add_reactive_spawn instead: that path is oracle-backed.",
      inputSchema: z.object({ sessionId, group: z.string().min(1), value: z.boolean() }).strict(),
      annotations: writes,
    },
    async (a) => mutate(a.sessionId, (s) => setDynamicSpawnTemplate(s.mission, a.group, a.value))
  );
}
