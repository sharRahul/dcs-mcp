/** Offline `.miz` authoring tools: create, modify, and save missions (copy-on-write). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  newSession,
  refresh,
  requireSession,
  saveSessionAs,
} from "../miz/sessions.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addTrigger,
  addTriggerZone,
  addWaypoint,
  setBriefing,
  setGroupTask,
  setPayload,
  setWeather,
  type ActionSpec,
  type ConditionSpec,
} from "../miz/authoring.js";
import { validateMission } from "../miz/validator.js";
import { addResource, listResources } from "../miz/resources.js";
import {
  FRAMEWORKS,
  loadScripts,
  resolveFrameworkPath,
  resolveLoadOrder,
  type FrameworkName,
} from "../miz/frameworks.js";
import { buildResult, errorResult, validationReportSchema, weatherSchema } from "./format.js";
import type { MissionSession } from "../miz/sessions.js";
import type { MissionDocument } from "../types.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const sessionIdField = z.string().min(1).describe("Session id from dcs_miz_open or dcs_miz_new");

const sideField = z.enum(["red", "blue", "neutrals"]).describe("Coalition side");

const unitTypeField = z
  .enum(["ALL", "AIRPLANE", "HELICOPTER", "GROUND_UNIT", "SHIP"])
  .describe("Unit category filter");

/** Shared shape of the text-message actions. */
const messageFields = {
  text: z.string().min(1).describe("Message text (stored in the mission dictionary)"),
  seconds: z.number().int().min(1).optional().describe("How long the message stays on screen"),
  clearview: z.boolean().optional().describe("Clear other messages first"),
  delaySeconds: z.number().int().min(0).optional().describe("Delay before the message appears"),
};

/** The per-group message is the one text action DCS gives no delay parameter. */
const { delaySeconds: _groupMessageHasNoDelay, ...groupMessageFields } = messageFields;

/** Actions that reference a file embedded in the .miz take a path on disk. */
const RESOURCE_ACTION_KINDS = new Set([
  "sound",
  "sound_to_coalition",
  "sound_to_group",
  "radio_transmission",
  "do_script_file",
]);

/**
 * Turn `file` (a path on disk) into an embedded resource + key, in place.
 *
 * Done at the tool layer so the authoring core stays synchronous and free of
 * filesystem access.
 */
async function materializeResources(
  session: MissionSession,
  actions: Record<string, unknown>[]
): Promise<{ fileName: string; key: string; bytes: number; reused: boolean }[]> {
  const embedded: { fileName: string; key: string; bytes: number; reused: boolean }[] = [];
  for (const action of actions) {
    if (!RESOURCE_ACTION_KINDS.has(String(action.kind))) continue;
    const filePath = action.file;
    if (typeof filePath !== "string") continue;
    const content = await readFile(filePath);
    const result = addResource(
      { mission: session.mission, mapResource: session.mapResource, files: session.files },
      basename(filePath),
      content
    );
    action.resourceKey = result.key;
    delete action.file;
    embedded.push({ fileName: result.fileName, key: result.key, bytes: result.bytes, reused: result.reused });
  }
  return embedded;
}

const positionFields = {
  x: z.number().describe("DCS internal x coordinate (metres, north). Use dcs_convert_coords for lat/long."),
  y: z.number().describe("DCS internal y coordinate (metres, east)."),
};

const authoringAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Diff two documents into an added/removed summary. */
function diffDocuments(base: MissionDocument, cur: MissionDocument) {
  const baseGroups = new Set(base.groups.map((g) => g.name));
  const curGroups = new Set(cur.groups.map((g) => g.name));
  const baseZones = new Set(base.zones.map((z) => z.name));
  const curZones = new Set(cur.zones.map((z) => z.name));
  return {
    groupsAdded: [...curGroups].filter((n) => !baseGroups.has(n)),
    groupsRemoved: [...baseGroups].filter((n) => !curGroups.has(n)),
    zonesAdded: [...curZones].filter((n) => !baseZones.has(n)),
    zonesRemoved: [...baseZones].filter((n) => !curZones.has(n)),
    weatherChanged: JSON.stringify(base.weather) !== JSON.stringify(cur.weather),
    briefingChanged: JSON.stringify(base.briefing) !== JSON.stringify(cur.briefing),
  };
}

export function registerMizAuthoringTools(server: McpServer): void {
  server.registerTool(
    "dcs_miz_new",
    {
      title: "New mission",
      description:
        "Create a new, empty mission session for a terrain. The result is a best-effort skeleton; " +
        "finalize it in the DCS Mission Editor. Add content with the dcs_miz_add_* tools, then save " +
        "with dcs_miz_save_as.\n\nArgs:\n  - theatre (string): e.g. 'Caucasus', 'PersianGulf', 'Syria'\n" +
        "  - startTime (number): mission start, seconds after midnight (default 43200 = noon)\n\n" +
        "Returns JSON: { sessionId, theatre }.",
      inputSchema: z
        .object({
          theatre: z.string().min(1).default("Caucasus").describe("Terrain/theatre name"),
          startTime: z.number().int().min(0).max(86400).default(43200).describe("Start time (seconds after midnight)"),
        })
        .strict(),
      outputSchema: z.object({ sessionId: z.string(), theatre: z.string() }),
      annotations: authoringAnnotations,
    },
    async ({ theatre, startTime }) => {
      try {
        const s = newSession(theatre, startTime);
        return buildResult(`Created new mission session ${s.id} on '${theatre}'.`, {
          sessionId: s.id,
          theatre,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_aircraft_group",
    {
      title: "Add aircraft group",
      description:
        "Add a fixed-wing or helicopter group to an open mission. Positions are DCS x/y metres; use " +
        "dcs_convert_coords to convert lat/long when DCS is running.\n\n" +
        "Args:\n  - sessionId, side, country (e.g. 'USA'), name, type (e.g. 'FA-18C_hornet')\n" +
        "  - category ('plane'|'helicopter'), count, x, y, altitudeMetres?, heading?, skill?, task?\n\n" +
        "Returns JSON: { added: groupName, groupCount }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          side: sideField,
          country: z.string().min(1).describe("Country name, e.g. 'USA', 'Russia'"),
          countryId: z.number().int().optional().describe("Explicit DCS country id (overrides name lookup)"),
          name: z.string().min(1).max(64).describe("Group name (must be unique)"),
          type: z.string().min(1).describe("DCS aircraft type id, e.g. 'FA-18C_hornet'"),
          category: z.enum(["plane", "helicopter"]).default("plane"),
          count: z.number().int().min(1).max(16).default(1).describe("Number of units"),
          ...positionFields,
          altitudeMetres: z.number().min(0).max(20000).default(6096).describe("Spawn altitude"),
          heading: z.number().min(0).max(359).default(0),
          skill: z.enum(["Average", "Good", "High", "Excellent", "Random", "Client", "Player"]).default("High"),
          task: z.string().optional().describe("Group task, e.g. 'CAP', 'CAS', 'SEAD'"),
        })
        .strict(),
      outputSchema: z.object({ added: z.string(), groupCount: z.number() }),
      annotations: authoringAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        addAircraftGroup(s.mission, a.category, {
          side: a.side,
          country: a.country,
          countryId: a.countryId,
          name: a.name,
          type: a.type,
          count: a.count,
          x: a.x,
          y: a.y,
          altitudeMetres: a.altitudeMetres,
          heading: a.heading,
          skill: a.skill,
          task: a.task,
        });
        s.dirty = true;
        refresh(s);
        return buildResult(`Added ${a.category} group '${a.name}' (${a.count} unit(s)).`, {
          added: a.name,
          groupCount: s.document.summary.groupCount,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_ground_group",
    {
      title: "Add ground/ship group",
      description:
        "Add a ground-vehicle or ship group to an open mission (DCS x/y metres).\n\n" +
        "Args:\n  - sessionId, side, country, name, type (e.g. 'M-1 Abrams')\n" +
        "  - category ('vehicle'|'ship'), count, x, y, heading?, skill?\n" +
        "  - composition?: [{ type, count }] mixed unit types in ONE group, in order. Use this for " +
        "SAM sites: a site is not N copies of one vehicle — an SA-6 needs its '1S91 str' radar AND " +
        "'Kub 2P25 ln' launchers in the same group or it registers with Skynet and never shoots. " +
        "Overrides type/count when given.\n" +
        "  - spacingMetres?: distance between units along the heading (default 20 for vehicles)\n\n" +
        "Units trail the lead along the heading, so the group faces the way it is pointed.\n\n" +
        "Returns JSON: { added, groupCount, unitCount }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          side: sideField,
          country: z.string().min(1),
          countryId: z.number().int().optional(),
          name: z.string().min(1).max(64),
          type: z.string().min(1).describe("DCS vehicle/ship type id, e.g. 'M-1 Abrams'"),
          category: z.enum(["vehicle", "ship"]).default("vehicle"),
          count: z.number().int().min(1).max(50).default(1),
          ...positionFields,
          heading: z.number().min(0).max(359).default(0),
          skill: z.enum(["Average", "Good", "High", "Excellent", "Random"]).default("Average"),
          composition: z
            .array(z.object({ type: z.string().min(1), count: z.number().int().min(1).max(50) }).strict())
            .min(1)
            .max(50)
            .optional()
            .describe("Mixed unit types in one group, in layout order. Overrides type/count."),
          spacingMetres: z
            .number()
            .min(1)
            .max(2000)
            .optional()
            .describe("Metres between units along the heading"),
        })
        .strict(),
      outputSchema: z.object({ added: z.string(), groupCount: z.number(), unitCount: z.number() }),
      annotations: authoringAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const group = addGroundGroup(s.mission, a.category, {
          side: a.side,
          country: a.country,
          countryId: a.countryId,
          name: a.name,
          type: a.type,
          count: a.count,
          x: a.x,
          y: a.y,
          heading: a.heading,
          skill: a.skill,
          composition: a.composition,
          spacingMetres: a.spacingMetres,
        });
        s.dirty = true;
        refresh(s);
        const unitCount = Object.keys((group["units"] ?? {}) as Record<string, unknown>).length;
        return buildResult(`Added ${a.category} group '${a.name}' (${unitCount} unit(s)).`, {
          added: a.name,
          groupCount: s.document.summary.groupCount,
          unitCount,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_trigger_zone",
    {
      title: "Add trigger zone",
      description:
        "Add a circular trigger zone to an open mission.\n\n" +
        "Args:\n  - sessionId, name, x, y, radius (metres)\n\nReturns JSON: { added, zoneCount }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          name: z.string().min(1).max(64),
          ...positionFields,
          radius: z.number().min(1).max(500000).describe("Zone radius in metres"),
        })
        .strict(),
      outputSchema: z.object({ added: z.string(), zoneCount: z.number() }),
      annotations: authoringAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        addTriggerZone(s.mission, { name: a.name, x: a.x, y: a.y, radius: a.radius });
        s.dirty = true;
        refresh(s);
        return buildResult(`Added trigger zone '${a.name}'.`, {
          added: a.name,
          zoneCount: s.document.summary.zoneCount,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_waypoint",
    {
      title: "Add waypoint",
      description:
        "Append a route waypoint to an existing group (by name). Positions are DCS x/y metres.\n\n" +
        "Args:\n  - sessionId, group (group name)\n  - x, y, altitudeMetres?, speedMps?\n" +
        "  - type? (e.g. 'Turning Point', 'TakeOff', 'Land'), action?, name?\n\n" +
        "Returns JSON: { group, waypointIndex, waypointCount }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          group: z.string().min(1).describe("Name of the group to add the waypoint to"),
          ...positionFields,
          altitudeMetres: z.number().min(0).max(20000).optional(),
          speedMps: z.number().min(0).max(1000).optional().describe("Speed in metres/second"),
          type: z.string().optional(),
          action: z.string().optional(),
          name: z.string().max(64).optional(),
        })
        .strict(),
      outputSchema: z.object({
        group: z.string(),
        waypointIndex: z.number(),
        waypointCount: z.number(),
      }),
      annotations: authoringAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const index = addWaypoint(s.mission, a.group, {
          x: a.x,
          y: a.y,
          altitudeMetres: a.altitudeMetres,
          speedMps: a.speedMps,
          type: a.type,
          action: a.action,
          name: a.name,
        });
        s.dirty = true;
        refresh(s);
        const grp = s.document.groups.find((g) => g.name === a.group);
        return buildResult(`Added waypoint #${index} to '${a.group}'.`, {
          group: a.group,
          waypointIndex: index,
          waypointCount: grp?.waypointCount ?? index,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_set_payload",
    {
      title: "Set unit payload",
      description:
        "Set a unit's loadout: fuel, countermeasures, gun, and pylon stores. CLSIDs are DCS store " +
        "ids (not validated offline).\n\n" +
        "Args:\n  - sessionId, unit (unit name)\n  - fuel?, flare?, chaff?, gun?\n" +
        "  - pylons?: [{ pylon: number, CLSID: string }]\n\nReturns JSON: { unit }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          unit: z.string().min(1).describe("Unit name (e.g. 'Colt 1-1')"),
          fuel: z.number().min(0).optional().describe("Internal fuel in kg"),
          flare: z.number().int().min(0).optional(),
          chaff: z.number().int().min(0).optional(),
          gun: z.number().int().min(0).max(100).optional().describe("Gun ammo percent"),
          pylons: z
            .array(z.object({ pylon: z.number().int().min(1), CLSID: z.string().min(1) }).strict())
            .optional()
            .describe("Pylon stores by station number"),
        })
        .strict(),
      outputSchema: z.object({ unit: z.string() }),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, unit, ...args }) => {
      try {
        const s = requireSession(sessionId);
        setPayload(s.mission, unit, args);
        s.dirty = true;
        refresh(s);
        return buildResult(`Updated payload for '${unit}'.`, { unit });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_set_group_task",
    {
      title: "Set group task",
      description:
        "Set a group's primary task (the label the Mission Editor shows).\n\n" +
        "Args:\n  - sessionId, group\n  - task (e.g. 'CAP', 'CAS', 'SEAD', 'Escort', 'AWACS', " +
        "'Refueling', 'Ground Nothing', 'Nothing')",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          group: z.string().min(1),
          task: z.string().min(1).describe("Task name"),
        })
        .strict(),
      outputSchema: z.object({ group: z.string(), task: z.string() }),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, group, task }) => {
      try {
        const s = requireSession(sessionId);
        setGroupTask(s.mission, group, task);
        s.dirty = true;
        refresh(s);
        return buildResult(`Set task of '${group}' to '${task}'.`, { group, task });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_add_trigger",
    {
      title: "Add trigger",
      description:
        "Add a mission trigger (conditions -> actions). Writes BOTH the Mission Editor's structured " +
        "form and the compiled runtime form, so the trigger fires when the .miz is flown directly — " +
        "no Mission Editor round-trip needed.\n\n" +
        "Groups, units and zones are given by NAME and resolved to DCS ids; a name that does not " +
        "exist in the mission is an error rather than a silently dead trigger. Flags are integers.\n\n" +
        "Trigger types: 'once' (fires once), 'continuous' (every time the condition holds), " +
        "'change' (each false->true transition), 'start' (mission start).\n\n" +
        "Conditions (ANDed): time_after{seconds}, time_since_flag{flag,seconds}, flag_is_true{flag}, " +
        "flag_is_false{flag}, flag_equals{flag,value}, flag_more{flag,value}, unit_in_zone{unit,zone}, " +
        "unit_out_zone{unit,zone}, unit_dead{unit}, group_dead{group}, group_life_less{group,percent}, " +
        "part_of_group_in_zone{group,zone}, part_of_coalition_in_zone{coalition,zone,unitType?}, " +
        "random_less{percent}.\n\n" +
        "Actions: message{text,seconds?,clearview?,delaySeconds?}, " +
        "message_to_coalition{coalition,text,...}, set_flag{flag,value?}, clear_flag{flag}, " +
        "activate_group{group}, deactivate_group{group}, group_on{group}, group_off{group}, " +
        "explode{zone,power?,altitudeMetres?}, smoke{zone,preset?,density?}, " +
        "signal_flare{zone,color?,altitudeMetres?,bearing?}, end_mission{winner,delaySeconds?}.\n\n" +
        "Args:\n  - sessionId\n  - type ('once'|'continuous'|'change'|'start')\n  - comment?\n" +
        "  - conditions: [ ... ] (empty means 'always')\n  - actions: [ ... ]\n\n" +
        "Returns JSON: { triggerIndex, triggerCount, compiled }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          type: z.enum(["once", "continuous", "change", "start"]).default("once"),
          comment: z.string().max(200).optional(),
          conditions: z
            .array(
              z.union([
                z.object({ kind: z.literal("time_after"), seconds: z.number().int().min(0) }).strict(),
                z
                  .object({
                    kind: z.literal("time_since_flag"),
                    flag: z.number().int(),
                    seconds: z.number().int().min(0),
                  })
                  .strict(),
                z.object({ kind: z.literal("flag_is_true"), flag: z.number().int() }).strict(),
                z.object({ kind: z.literal("flag_is_false"), flag: z.number().int() }).strict(),
                z
                  .object({ kind: z.literal("flag_equals"), flag: z.number().int(), value: z.number().int() })
                  .strict(),
                z
                  .object({ kind: z.literal("flag_more"), flag: z.number().int(), value: z.number().int() })
                  .strict(),
                z
                  .object({ kind: z.literal("unit_in_zone"), unit: z.string().min(1), zone: z.string().min(1) })
                  .strict(),
                z
                  .object({ kind: z.literal("unit_out_zone"), unit: z.string().min(1), zone: z.string().min(1) })
                  .strict(),
                z.object({ kind: z.literal("unit_dead"), unit: z.string().min(1) }).strict(),
                z.object({ kind: z.literal("group_dead"), group: z.string().min(1) }).strict(),
                z
                  .object({
                    kind: z.literal("group_life_less"),
                    group: z.string().min(1),
                    percent: z.number().int().min(0).max(100),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("part_of_group_in_zone"),
                    group: z.string().min(1),
                    zone: z.string().min(1),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("part_of_coalition_in_zone"),
                    coalition: sideField,
                    zone: z.string().min(1),
                    unitType: unitTypeField.optional(),
                  })
                  .strict(),
                z.object({ kind: z.literal("random_less"), percent: z.number().int().min(0).max(100) }).strict(),
              ])
            )
            .describe("Trigger conditions, ANDed together. An empty list means 'always'."),
          actions: z
            .array(
              z.union([
                z.object({ kind: z.literal("message"), ...messageFields }).strict(),
                z
                  .object({ kind: z.literal("message_to_coalition"), coalition: sideField, ...messageFields })
                  .strict(),
                z
                  .object({ kind: z.literal("set_flag"), flag: z.number().int(), value: z.number().int().optional() })
                  .strict(),
                z.object({ kind: z.literal("clear_flag"), flag: z.number().int() }).strict(),
                z.object({ kind: z.literal("activate_group"), group: z.string().min(1) }).strict(),
                z.object({ kind: z.literal("deactivate_group"), group: z.string().min(1) }).strict(),
                z.object({ kind: z.literal("group_on"), group: z.string().min(1) }).strict(),
                z.object({ kind: z.literal("group_off"), group: z.string().min(1) }).strict(),
                z
                  .object({
                    kind: z.literal("explode"),
                    zone: z.string().min(1),
                    power: z.number().min(1).max(10000).optional().describe("Explosion power"),
                    altitudeMetres: z.number().min(0).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("smoke"),
                    zone: z.string().min(1),
                    preset: z.number().int().min(1).max(8).optional().describe("DCS smoke preset"),
                    density: z.number().int().min(1).max(4).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("signal_flare"),
                    zone: z.string().min(1),
                    color: z.number().int().min(0).max(3).optional().describe("0=green 1=red 2=white 3=yellow"),
                    altitudeMetres: z.number().min(0).optional(),
                    bearing: z.number().min(0).max(359).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("end_mission"),
                    winner: sideField,
                    delaySeconds: z.number().int().min(0).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("message_to_group"),
                    group: z.string().min(1),
                    ...groupMessageFields,
                  })
                  .strict(),
                z.object({ kind: z.literal("message_to_unit"), unit: z.string().min(1), ...messageFields }).strict(),
                z
                  .object({
                    kind: z.literal("message_to_country"),
                    countryId: z.number().int().min(0).describe("DCS country id, e.g. 2 = USA, 0 = Russia"),
                    ...messageFields,
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("set_flag_random"),
                    flag: z.number().int(),
                    min: z.number().int(),
                    max: z.number().int(),
                  })
                  .strict(),
                z.object({ kind: z.literal("group_resume"), group: z.string().min(1) }).strict(),

                // --- radio menu (F10 "Other") ---
                z
                  .object({
                    kind: z.literal("add_radio_item"),
                    text: z.string().min(1).describe("Menu label"),
                    flag: z.number().int().describe("Flag set when the player picks the item"),
                    value: z.number().int().optional().describe("Value written to the flag (default 1)"),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("add_radio_item_for_group"),
                    group: z.string().min(1),
                    text: z.string().min(1),
                    flag: z.number().int(),
                    value: z.number().int().optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("wait_for_user_flag"),
                    flag: z.number().int().describe("Flag a radio menu item raises when picked"),
                    flagBack: z.number().int().optional(),
                  })
                  .strict(),
                z.object({ kind: z.literal("remove_radio_item"), text: z.string().min(1) }).strict(),
                z
                  .object({
                    kind: z.literal("remove_radio_item_for_group"),
                    group: z.string().min(1),
                    text: z.string().min(1),
                  })
                  .strict(),

                // --- sound / radio (file is a path on disk; it is embedded in the .miz) ---
                z
                  .object({
                    kind: z.literal("sound"),
                    file: z.string().min(1),
                    delaySeconds: z.number().int().min(0).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("sound_to_coalition"),
                    coalition: sideField,
                    file: z.string().min(1),
                    delaySeconds: z.number().int().min(0).optional(),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("sound_to_group"),
                    group: z.string().min(1),
                    file: z.string().min(1),
                    delaySeconds: z.number().int().min(0).optional(),
                  })
                  .strict(),
                z.object({ kind: z.literal("stop_sound") }).strict(),
                z
                  .object({
                    kind: z.literal("radio_transmission"),
                    file: z.string().min(1).describe("Path to an .ogg to embed and broadcast"),
                    zone: z.string().min(1).describe("Trigger zone the transmitter sits in"),
                    frequencyMHz: z.number().min(0).describe("Frequency in MHz, e.g. 251 or 127.5"),
                    name: z.string().min(1).describe("Transmission name (used to stop it later)"),
                    power: z.number().int().min(1).optional(),
                    modulationAM: z.boolean().optional().describe("true = AM (default), false = FM"),
                    loop: z.boolean().optional(),
                    delaySeconds: z.number().int().min(0).optional(),
                    micEffects: z.boolean().optional(),
                    squelchEffects: z.boolean().optional(),
                  })
                  .strict(),

                // --- scripting ---
                z
                  .object({
                    kind: z.literal("do_script"),
                    text: z.string().min(1).describe("Inline Lua run in the mission environment"),
                  })
                  .strict(),
                z
                  .object({
                    kind: z.literal("do_script_file"),
                    file: z.string().min(1).describe("Path to a .lua file to embed and run"),
                  })
                  .strict(),
              ])
            )
            .min(1)
            .describe("Trigger actions"),
        })
        .strict(),
      outputSchema: z.object({
        triggerIndex: z.number(),
        triggerCount: z.number(),
        compiled: z.boolean(),
      }),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, type, comment, conditions, actions }) => {
      try {
        const s = requireSession(sessionId);
        // Embed any referenced sound/script files first, so the actions can be
        // built against real resource keys.
        const spec = actions as unknown as Record<string, unknown>[];
        const embedded = await materializeResources(s, spec);
        const index = addTrigger(
          s.mission,
          {
            type,
            comment,
            conditions: conditions as ConditionSpec[],
            actions: spec as unknown as ActionSpec[],
          },
          s.dictionary
        );
        s.dirty = true;
        refresh(s);
        const compiled = s.document.triggers.find((t) => t.index === index)?.compiled ?? false;
        const extra = embedded.length ? ` Embedded ${embedded.map((e) => e.fileName).join(", ")}.` : "";
        return buildResult(
          compiled
            ? `Added ${type} trigger #${index} and compiled it into mission.trig; it will fire when flown directly.${extra}`
            : `Added ${type} trigger #${index}, but it could not be compiled — open the saved .miz in the ` +
              `DCS Mission Editor once to finalize it.${extra}`,
          {
            triggerIndex: index,
            triggerCount: s.document.summary.triggerCount,
            compiled,
            embedded,
          }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_load_scripts",
    {
      title: "Load mission scripts / frameworks",
      description:
        "Embed Lua scripting frameworks (MIST, MOOSE, Skynet-IADS) and/or your own setup scripts into " +
        "an open mission, and wire them to run at mission start.\n\n" +
        "All loads go into ONE 'Load Scripts' MISSION START trigger, in dependency order " +
        "(MIST -> MOOSE -> Skynet -> your scripts). This matters: DCS gives no defined order between " +
        "separate start triggers, and Skynet fails to initialise unless MIST loaded first. Requesting " +
        "skynet pulls in mist automatically.\n\n" +
        "Framework files are auto-discovered under 'Saved Games/DCS/Missions/LUA Scripts' and " +
        "'Saved Games/DCS/Scripts'; pass paths explicitly to override. Re-loading a framework already " +
        "in the mission reuses it instead of embedding a second copy.\n\n" +
        "Args:\n  - sessionId\n  - frameworks?: ['mist'|'moose'|'skynet']\n" +
        "  - frameworkPaths?: { mist?, moose?, skynet? } explicit .lua paths\n" +
        "  - scripts?: [string] paths to your own .lua files, loaded after the frameworks\n\n" +
        "Returns JSON: { triggerIndex, loaded: [{ framework?, fileName, resourceKey, bytes, reused }] }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          frameworks: z
            .array(z.enum(["mist", "moose", "skynet"]))
            .default([])
            .describe("Frameworks to embed; dependencies are added automatically"),
          frameworkPaths: z
            .object({
              mist: z.string().optional(),
              moose: z.string().optional(),
              skynet: z.string().optional(),
            })
            .strict()
            .optional()
            .describe("Explicit .lua paths, overriding auto-discovery"),
          scripts: z
            .array(z.string().min(1))
            .default([])
            .describe("Your own .lua files, loaded after the frameworks in the order given"),
        })
        .strict(),
      outputSchema: z.object({
        triggerIndex: z.number(),
        loaded: z.array(
          z.object({
            framework: z.string().optional(),
            fileName: z.string(),
            sourcePath: z.string(),
            resourceKey: z.string(),
            bytes: z.number(),
            reused: z.boolean(),
          })
        ),
      }),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, frameworks, frameworkPaths, scripts }) => {
      try {
        const s = requireSession(sessionId);
        if (frameworks.length === 0 && scripts.length === 0) {
          throw new Error("Nothing to load: pass at least one framework or script path.");
        }

        const ordered = resolveLoadOrder(frameworks as FrameworkName[]);
        const requests: { framework?: FrameworkName; filePath: string }[] = [];
        for (const name of ordered) {
          requests.push({
            framework: name,
            filePath: await resolveFrameworkPath(name, frameworkPaths?.[name]),
          });
        }
        for (const filePath of scripts) requests.push({ filePath });

        const { loaded, triggerIndex } = await loadScripts(
          { mission: s.mission, mapResource: s.mapResource, files: s.files },
          s.dictionary,
          requests
        );
        s.dirty = true;
        refresh(s);

        const size = (bytes: number) =>
          bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
        const summary = loaded
          .map((l) => `${l.framework ? FRAMEWORKS[l.framework].label : "script"} ${l.fileName}` +
            `${l.reused ? " (already loaded)" : ` (${size(l.bytes)})`}`)
          .join(", ");
        return buildResult(
          `Load order on start trigger #${triggerIndex}: ${summary}.`,
          { triggerIndex, loaded }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_list_resources",
    {
      title: "List embedded resources",
      description:
        "List the files embedded in an open mission (scripts, sounds, pictures) and the resource key " +
        "each is reachable by.\n\nArgs:\n  - sessionId\n\n" +
        "Returns JSON: { resources: [{ key, fileName }], pendingFiles: [string] }.",
      inputSchema: z.object({ sessionId: sessionIdField }).strict(),
      outputSchema: z.object({
        resources: z.array(z.object({ key: z.string(), fileName: z.string() })),
        pendingFiles: z.array(z.string()),
      }),
      annotations: { ...authoringAnnotations, readOnlyHint: true, idempotentHint: true },
    },
    async ({ sessionId }) => {
      try {
        const s = requireSession(sessionId);
        const resources = listResources(s.mapResource);
        const pendingFiles = [...s.files.keys()].sort();
        const lines = resources.length
          ? resources.map((r) => `- ${r.fileName}  (${r.key})`).join("\n")
          : "(none)";
        return buildResult(`# Embedded resources\n\n${lines}`, { resources, pendingFiles });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_set_weather",
    {
      title: "Set weather",
      description:
        "Update supported weather fields of an open mission. Only provided fields change.\n\n" +
        "Args:\n  - sessionId\n  - temperatureCelsius?, qnhMmHg?, cloudBaseMetres?, windGroundSpeed?, windGroundDir?",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          temperatureCelsius: z.number().min(-60).max(60).optional(),
          qnhMmHg: z.number().min(650).max(850).optional(),
          cloudBaseMetres: z.number().min(0).max(15000).optional(),
          windGroundSpeed: z.number().min(0).max(97).optional(),
          windGroundDir: z.number().min(0).max(359).optional(),
        })
        .strict(),
      outputSchema: weatherSchema,
      annotations: authoringAnnotations,
    },
    async ({ sessionId, ...args }) => {
      try {
        const s = requireSession(sessionId);
        setWeather(s.mission, args);
        s.dirty = true;
        refresh(s);
        return buildResult(`Updated weather.`, s.document.weather as unknown as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_set_briefing",
    {
      title: "Set briefing",
      description:
        "Set the mission briefing title and/or description text.\n\n" +
        "Args:\n  - sessionId\n  - title?\n  - description?",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          title: z.string().max(500).optional(),
          description: z.string().max(10000).optional(),
        })
        .strict(),
      outputSchema: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, title, description }) => {
      try {
        const s = requireSession(sessionId);
        setBriefing(s.mission, title, description);
        s.dirty = true;
        refresh(s);
        return buildResult(`Updated briefing.`, { title, description });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_diff",
    {
      title: "Diff mission changes",
      description:
        "Show what has changed in an open session since it was opened/created: groups and zones " +
        "added/removed, and whether weather or briefing changed.\n\nArgs:\n  - sessionId\n\n" +
        "Returns JSON: { groupsAdded, groupsRemoved, zonesAdded, zonesRemoved, weatherChanged, briefingChanged }.",
      inputSchema: z.object({ sessionId: sessionIdField }).strict(),
      outputSchema: z.object({
        groupsAdded: z.array(z.string()),
        groupsRemoved: z.array(z.string()),
        zonesAdded: z.array(z.string()),
        zonesRemoved: z.array(z.string()),
        weatherChanged: z.boolean(),
        briefingChanged: z.boolean(),
      }),
      annotations: { ...authoringAnnotations, readOnlyHint: true, idempotentHint: true },
    },
    async ({ sessionId }) => {
      try {
        const s = requireSession(sessionId);
        const diff = diffDocuments(s.baseline, s.document);
        return buildResult(JSON.stringify(diff, null, 2), diff);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_save_as",
    {
      title: "Save mission as",
      description:
        "Save the open session to a NEW .miz file (copy-on-write; never overwrites the source). Runs " +
        "validation first and refuses to save on validation errors unless force=true, and refuses to " +
        "replace an existing file unless overwrite=true.\n\n" +
        "Args:\n  - sessionId\n  - outPath (string): destination .miz path\n  - force? (bool): save despite errors\n" +
        "  - overwrite? (bool): replace outPath if it already exists\n\n" +
        "Returns JSON: { saved, outPath, digest (sha256), validation }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          outPath: z.string().min(1).describe("Destination path ending in .miz"),
          force: z.boolean().default(false).describe("Save even if validation reports errors"),
          overwrite: z
            .boolean()
            .default(false)
            .describe("Replace outPath if a file is already there (destructive)"),
        })
        .strict(),
      outputSchema: z.object({
        saved: z.boolean(),
        outPath: z.string().optional(),
        digest: z.string().optional(),
        validation: validationReportSchema,
      }),
      // Writes to the filesystem, and can replace an existing file when overwrite=true.
      annotations: { ...authoringAnnotations, destructiveHint: true },
    },
    async ({ sessionId, outPath, force, overwrite }) => {
      try {
        const s = requireSession(sessionId);
        const report = validateMission(s.document);
        if (!report.ok && !force) {
          return buildResult(
            `Not saved: ${report.errors.length} validation error(s). Fix them or pass force=true.`,
            { saved: false, validation: report }
          );
        }
        const { digest } = await saveSessionAs(s, outPath, overwrite);
        return buildResult(`Saved mission to ${outPath}.`, {
          saved: true,
          outPath,
          digest,
          validation: report,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
