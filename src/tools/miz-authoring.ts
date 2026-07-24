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
import { buildResult, errorResult } from "./format.js";
import type { MissionDocument } from "../types.js";

const sessionIdField = z.string().min(1).describe("Session id from dcs_miz_open or dcs_miz_new");

const sideField = z.enum(["red", "blue", "neutrals"]).describe("Coalition side");

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
        "  - category ('vehicle'|'ship'), count, x, y, heading?, skill?\n\n" +
        "Returns JSON: { added, groupCount }.",
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
        })
        .strict(),
      annotations: authoringAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        addGroundGroup(s.mission, a.category, {
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
        "Add a mission trigger (condition -> action) in the DCS Mission Editor's structured form. " +
        "IMPORTANT: DCS compiles the runtime triggers when the mission is opened and saved in the " +
        "Mission Editor, so open the saved .miz in the ME once to finalize triggers.\n\n" +
        "Supported conditions: time_after{seconds}, flag_is_true{flag}, flag_equals{flag,value}.\n" +
        "Supported actions: message{text,seconds?}, set_flag{flag,value?}, activate_group{group}, " +
        "end_mission{winner}.\n\n" +
        "Args:\n  - sessionId\n  - type ('start'|'once'|'continuous')\n  - comment?\n" +
        "  - conditions: [ ... ]\n  - actions: [ ... ]\n\nReturns JSON: { triggerIndex, triggerCount }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          type: z.enum(["start", "once", "continuous"]).default("once"),
          comment: z.string().max(200).optional(),
          conditions: z
            .array(
              z.union([
                z.object({ kind: z.literal("time_after"), seconds: z.number().int().min(0) }).strict(),
                z.object({ kind: z.literal("flag_is_true"), flag: z.number().int() }).strict(),
                z
                  .object({ kind: z.literal("flag_equals"), flag: z.number().int(), value: z.number().int() })
                  .strict(),
              ])
            )
            .min(1)
            .describe("Trigger conditions (ANDed)"),
          actions: z
            .array(
              z.union([
                z
                  .object({
                    kind: z.literal("message"),
                    text: z.string().min(1),
                    seconds: z.number().int().min(1).optional(),
                  })
                  .strict(),
                z
                  .object({ kind: z.literal("set_flag"), flag: z.number().int(), value: z.number().int().optional() })
                  .strict(),
                z.object({ kind: z.literal("activate_group"), group: z.string().min(1) }).strict(),
                z.object({ kind: z.literal("end_mission"), winner: z.enum(["red", "blue", "neutrals"]) }).strict(),
              ])
            )
            .min(1)
            .describe("Trigger actions"),
        })
        .strict(),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, type, comment, conditions, actions }) => {
      try {
        const s = requireSession(sessionId);
        const index = addTrigger(s.mission, {
          type,
          comment,
          conditions: conditions as ConditionSpec[],
          actions: actions as ActionSpec[],
        });
        s.dirty = true;
        refresh(s);
        return buildResult(
          `Added ${type} trigger #${index}. Open the saved .miz in the DCS Mission Editor to finalize it.`,
          { triggerIndex: index, triggerCount: s.document.summary.triggerCount }
        );
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
        "validation first and refuses to save on validation errors unless force=true.\n\n" +
        "Args:\n  - sessionId\n  - outPath (string): destination .miz path\n  - force? (bool): save despite errors\n\n" +
        "Returns JSON: { outPath, digest (sha256), validation }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          outPath: z.string().min(1).describe("Destination path ending in .miz"),
          force: z.boolean().default(false).describe("Save even if validation reports errors"),
        })
        .strict(),
      annotations: authoringAnnotations,
    },
    async ({ sessionId, outPath, force }) => {
      try {
        const s = requireSession(sessionId);
        const report = validateMission(s.document);
        if (!report.ok && !force) {
          return buildResult(
            `Not saved: ${report.errors.length} validation error(s). Fix them or pass force=true.`,
            { saved: false, validation: report }
          );
        }
        const { digest } = await saveSessionAs(s, outPath);
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
