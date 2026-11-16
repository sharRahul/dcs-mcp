/**
 * Offline `.miz` editing tools: change or remove what is already in a mission,
 * add static objects, set mission-wide options, and list triggers/zones.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refresh, requireSession, type MissionSession } from "../miz/sessions.js";
import {
  addStatic,
  FORCED_OPTIONS,
  moveGroup,
  moveUnit,
  removeGroup,
  removeUnit,
  removeWaypoint,
  removeZone,
  renameGroup,
  renameUnit,
  setMissionOptions,
  updateGroup,
  updateWaypoint,
  updateZone,
  type ForcedOptionKey,
} from "../miz/editing.js";
import { removeTrigger, updateTrigger } from "../miz/authoring.js";
import { listResources } from "../miz/resources.js";
import { buildResult, errorResult, render, responseFormatField } from "./format.js";
import { positionFields, resolveOptionalPosition, resolvePosition } from "./position.js";

const sessionIdField = z.string().min(1).describe("Session id from dcs_miz_open or dcs_miz_new");
const sideField = z.enum(["red", "blue", "neutrals"]).describe("Coalition side");
const forceField = z
  .boolean()
  .default(false)
  .describe("Remove even if triggers reference it (they will never fire). Default false.");

const editAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Removal discards mission content (recoverable only by not saving). */
const removeAnnotations = { ...editAnnotations, destructiveHint: true } as const;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function touched(s: MissionSession): void {
  s.dirty = true;
  refresh(s);
}

/**
 * Script resources that mention a name. A rename cannot safely rewrite Lua it
 * does not execute, so the caller is told where the old name still appears.
 */
function scriptsMentioning(s: MissionSession, name: string): string[] {
  const hits: string[] = [];
  for (const { fileName } of listResources(s.mapResource)) {
    const bytes = s.files.get(fileName);
    if (bytes && fileName.endsWith(".lua") && bytes.toString("utf8").includes(name)) hits.push(fileName);
  }
  const serialized = JSON.stringify(s.mission["trigrules"] ?? {});
  if (serialized.includes(name)) hits.push("inline trigger text (do_script / messages)");
  return hits;
}

const removalOutput = z.object({ removed: z.string(), danglingTriggers: z.array(z.number()) });

function removalText(kind: string, name: string, dangling: number[]): string {
  return dangling.length
    ? `Removed ${kind} '${name}'. WARNING: trigger(s) ${dangling.map((i) => `#${i}`).join(", ")} still ` +
        `reference it and will never fire.`
    : `Removed ${kind} '${name}'.`;
}

export function registerMizEditingTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_miz_remove_group",
    {
      title: "Remove group",
      description:
        "Remove a group (aircraft, ground, ship or static) by name. Refused if a trigger references the " +
        "group or any of its units, unless force=true — such a trigger would silently never fire.\n\n" +
        "Args: sessionId, name, force?\n\nReturns JSON: { removed, danglingTriggers }.",
      inputSchema: z.object({ sessionId: sessionIdField, name: z.string().min(1), force: forceField }).strict(),
      outputSchema: removalOutput,
      annotations: removeAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const r = removeGroup(s.mission, s.document.triggers, a.name, a.force);
        touched(s);
        return buildResult(removalText("group", a.name, r.danglingTriggers), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_remove_unit",
    {
      title: "Remove unit",
      description:
        "Remove one unit from its group. The last unit of a group cannot be removed (remove the group). " +
        "Refused if a trigger references the unit, unless force=true.\n\n" +
        "Args: sessionId, unit, force?\n\nReturns JSON: { removed, danglingTriggers }.",
      inputSchema: z.object({ sessionId: sessionIdField, unit: z.string().min(1), force: forceField }).strict(),
      outputSchema: removalOutput,
      annotations: removeAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const r = removeUnit(s.mission, s.document.triggers, a.unit, a.force);
        touched(s);
        return buildResult(removalText("unit", a.unit, r.danglingTriggers), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_remove_zone",
    {
      title: "Remove trigger zone",
      description:
        "Remove a trigger zone by name. Refused if a trigger references it, unless force=true.\n\n" +
        "Args: sessionId, name, force?\n\nReturns JSON: { removed, danglingTriggers }.",
      inputSchema: z.object({ sessionId: sessionIdField, name: z.string().min(1), force: forceField }).strict(),
      outputSchema: removalOutput,
      annotations: removeAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const r = removeZone(s.mission, s.document.triggers, a.name, a.force);
        touched(s);
        return buildResult(removalText("zone", a.name, r.danglingTriggers), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_remove_trigger",
    {
      title: "Remove trigger",
      description:
        "Remove a trigger by index (see dcs_miz_list_triggers) from both the editor form and the compiled " +
        "runtime form. Later triggers move down one index and are recompiled. Refused when a later trigger " +
        "uses a predicate this server cannot compile, because renumbering it would break its compiled Lua.\n\n" +
        "Args: sessionId, index\n\nReturns JSON: { removed (comment), recompiled: [indices] }.",
      inputSchema: z.object({ sessionId: sessionIdField, index: z.number().int().min(1) }).strict(),
      outputSchema: z.object({ removed: z.string(), recompiled: z.array(z.number()) }),
      annotations: removeAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const r = removeTrigger(s.mission, a.index);
        touched(s);
        return buildResult(
          `Removed trigger #${a.index}${r.removed ? ` ('${r.removed}')` : ""}. ` +
            `${r.recompiled.length} later trigger(s) renumbered and recompiled.`,
          { ...r }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_update_trigger",
    {
      title: "Update trigger",
      description:
        "Change a trigger's type (start | once | continuous | change) and/or comment, recompiling its " +
        "runtime wiring. To change conditions or actions, remove the trigger and add it again.\n\n" +
        "Args: sessionId, index, type?, comment?\n\nReturns JSON: { index }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          index: z.number().int().min(1),
          type: z.enum(["start", "once", "continuous", "change"]).optional(),
          comment: z.string().max(256).optional(),
        })
        .strict(),
      outputSchema: z.object({ index: z.number() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        updateTrigger(s.mission, a.index, { type: a.type, comment: a.comment });
        touched(s);
        return buildResult(`Updated trigger #${a.index}.`, { index: a.index });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Rename / move / update
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_miz_rename_group",
    {
      title: "Rename group",
      description:
        "Rename a group. Units named '<old>-N' are renamed '<new>-N' too unless renameUnits=false. " +
        "Triggers keep working (they reference ids). Scripts that look groups up by name — Skynet prefixes " +
        "('SAM…', 'EW…'), MOOSE, inline do_script text — are NOT rewritten; the result lists where the old " +
        "name still appears.\n\nArgs: sessionId, from, to, renameUnits?\n\n" +
        "Returns JSON: { renamedUnits: [{from,to}], stillMentionedIn: [..] }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          from: z.string().min(1),
          to: z.string().min(1).max(64),
          renameUnits: z.boolean().default(true),
        })
        .strict(),
      outputSchema: z.object({
        renamedUnits: z.array(z.object({ from: z.string(), to: z.string() })),
        stillMentionedIn: z.array(z.string()),
      }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const r = renameGroup(s.mission, a.from, a.to, a.renameUnits);
        touched(s);
        const mentions = scriptsMentioning(s, a.from);
        return buildResult(
          `Renamed group '${a.from}' to '${a.to}' (${r.renamedUnits.length} unit(s) renamed).` +
            (mentions.length ? ` The old name still appears in: ${mentions.join(", ")}.` : ""),
          { renamedUnits: r.renamedUnits, stillMentionedIn: mentions }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_rename_unit",
    {
      title: "Rename unit",
      description:
        "Rename one unit. Refuses a name already in use. Scripts that mention the old name are listed, " +
        "not rewritten.\n\nArgs: sessionId, from, to\n\nReturns JSON: { stillMentionedIn }.",
      inputSchema: z
        .object({ sessionId: sessionIdField, from: z.string().min(1), to: z.string().min(1).max(64) })
        .strict(),
      outputSchema: z.object({ stillMentionedIn: z.array(z.string()) }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        renameUnit(s.mission, a.from, a.to);
        touched(s);
        const mentions = scriptsMentioning(s, a.from);
        return buildResult(
          `Renamed unit '${a.from}' to '${a.to}'.` +
            (mentions.length ? ` The old name still appears in: ${mentions.join(", ")}.` : ""),
          { stillMentionedIn: mentions }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_move_group",
    {
      title: "Move group",
      description:
        "Move a group so its lead unit sits at the new position, keeping the formation's shape. The spawn " +
        "point (waypoint 1) moves with it; later waypoints stay unless moveRoute=true. A new heading " +
        "(degrees) rotates the formation about the lead.\n\n" +
        "Args: sessionId, name, x/y or lat/lon, heading?, moveRoute?\n\nReturns JSON: { name, x, y }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          name: z.string().min(1),
          ...positionFields,
          heading: z.number().min(0).max(360).optional(),
          moveRoute: z.boolean().default(false),
        })
        .strict(),
      outputSchema: z.object({ name: z.string(), x: z.number(), y: z.number() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        moveGroup(s.mission, a.name, { ...pos, heading: a.heading, moveRoute: a.moveRoute });
        touched(s);
        return buildResult(`Moved group '${a.name}' to x=${pos.x.toFixed(1)}, y=${pos.y.toFixed(1)}.`, {
          name: a.name,
          ...pos,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_move_unit",
    {
      title: "Move unit",
      description:
        "Move one unit (and, for a group's lead unit, the spawn point with it). heading is degrees.\n\n" +
        "Args: sessionId, unit, x/y or lat/lon, heading?\n\nReturns JSON: { unit, x, y }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          unit: z.string().min(1),
          ...positionFields,
          heading: z.number().min(0).max(360).optional(),
        })
        .strict(),
      outputSchema: z.object({ unit: z.string(), x: z.number(), y: z.number() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        moveUnit(s.mission, a.unit, pos.x, pos.y, a.heading);
        touched(s);
        return buildResult(`Moved unit '${a.unit}'.`, { unit: a.unit, ...pos });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_update_group",
    {
      title: "Update group",
      description:
        "Change group settings: skill (all units), task, lateActivation (spawn only when an " +
        "activate_group trigger fires), hidden (off the F10 map), uncontrolled (aircraft only: parked and " +
        "inert until started by a trigger).\n\n" +
        "Args: sessionId, name, skill?, task?, lateActivation?, hidden?, uncontrolled?\n\n" +
        "Returns JSON: { name, changed: [fields] }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          name: z.string().min(1),
          skill: z.enum(["Average", "Good", "High", "Excellent", "Random", "Client", "Player"]).optional(),
          task: z.string().min(1).optional(),
          lateActivation: z.boolean().optional(),
          hidden: z.boolean().optional(),
          uncontrolled: z.boolean().optional(),
        })
        .strict(),
      outputSchema: z.object({ name: z.string(), changed: z.array(z.string()) }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const { sessionId: _sid, name, ...changes } = a;
        const changed = updateGroup(s.mission, name, changes);
        touched(s);
        return buildResult(`Updated '${name}': ${changed.join(", ") || "nothing"}.`, { name, changed });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_update_waypoint",
    {
      title: "Update waypoint",
      description:
        "Change a waypoint of a group (1-based index). Waypoint 1 is the spawn point: its position moves " +
        "with dcs_miz_move_group, but its altitude/speed/name can be set here.\n\n" +
        "Args: sessionId, group, index, x/y or lat/lon?, altitudeMetres?, speedMps?, name?\n\n" +
        "Returns JSON: { group, index }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          group: z.string().min(1),
          index: z.number().int().min(1),
          ...positionFields,
          altitudeMetres: z.number().min(0).max(20000).optional(),
          speedMps: z.number().min(0).max(1000).optional(),
          name: z.string().max(64).optional(),
        })
        .strict(),
      outputSchema: z.object({ group: z.string(), index: z.number() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolveOptionalPosition(s, a);
        updateWaypoint(s.mission, a.group, a.index, {
          x: pos?.x,
          y: pos?.y,
          altitudeMetres: a.altitudeMetres,
          speedMps: a.speedMps,
          name: a.name,
        });
        touched(s);
        return buildResult(`Updated waypoint ${a.index} of '${a.group}'.`, { group: a.group, index: a.index });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_remove_waypoint",
    {
      title: "Remove waypoint",
      description:
        "Remove waypoint N (>= 2) from a group's route. Waypoint 1 is the spawn point and cannot be removed.\n\n" +
        "Args: sessionId, group, index\n\nReturns JSON: { group, waypointCount }.",
      inputSchema: z
        .object({ sessionId: sessionIdField, group: z.string().min(1), index: z.number().int().min(1) })
        .strict(),
      outputSchema: z.object({ group: z.string(), waypointCount: z.number() }),
      annotations: removeAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const count = removeWaypoint(s.mission, a.group, a.index);
        touched(s);
        return buildResult(`Removed waypoint ${a.index} from '${a.group}' (${count} left).`, {
          group: a.group,
          waypointCount: count,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_update_zone",
    {
      title: "Update trigger zone",
      description:
        "Rename, move, resize or hide a trigger zone. Triggers keep working (they reference the zone id).\n\n" +
        "Args: sessionId, name, newName?, x/y or lat/lon?, radius?, hidden?\n\nReturns JSON: { name }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          name: z.string().min(1),
          newName: z.string().min(1).max(64).optional(),
          ...positionFields,
          radius: z.number().min(1).max(500000).optional(),
          hidden: z.boolean().optional(),
        })
        .strict(),
      outputSchema: z.object({ name: z.string() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolveOptionalPosition(s, a);
        updateZone(s.mission, a.name, { name: a.newName, x: pos?.x, y: pos?.y, radius: a.radius, hidden: a.hidden });
        touched(s);
        return buildResult(`Updated zone '${a.newName ?? a.name}'.`, { name: a.newName ?? a.name });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Statics and mission options
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_miz_add_static",
    {
      title: "Add static object",
      description:
        "Add a static object — buildings, fortifications, FARP equipment, cargo, or a parked aircraft/" +
        "vehicle/ship as scenery. Type ids come from dcs_list_unit_types (category=static, or any aircraft/" +
        "vehicle/ship type). Cargo statics take massKg (default 1000) for sling loading.\n\n" +
        "Args: sessionId, side, country, name, type, x/y or lat/lon, heading? (degrees), hidden?, dead?, massKg?\n\n" +
        "Returns JSON: { added, category }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          side: sideField,
          country: z.string().min(1),
          countryId: z.number().int().optional(),
          name: z.string().min(1).max(64),
          type: z.string().min(1),
          ...positionFields,
          heading: z.number().min(0).max(360).default(0),
          hidden: z.boolean().default(false),
          dead: z.boolean().default(false).describe("Place as a destroyed wreck"),
          massKg: z.number().min(1).max(100000).optional(),
        })
        .strict(),
      outputSchema: z.object({ added: z.string(), category: z.string() }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const pos = resolvePosition(s, a);
        const group = addStatic(s.mission, {
          side: a.side,
          country: a.country,
          countryId: a.countryId,
          name: a.name,
          type: a.type,
          x: pos.x,
          y: pos.y,
          heading: a.heading,
          hidden: a.hidden,
          dead: a.dead,
          massKg: a.massKg,
        });
        touched(s);
        const unit = (group["units"] as Record<number, Record<string, unknown>>)[1];
        return buildResult(`Added static '${a.name}' (${a.type}).`, {
          added: a.name,
          category: String(unit["category"]),
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  const forcedOptionShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(FORCED_OPTIONS)) {
    forcedOptionShape[key] = (
      Array.isArray(spec)
        ? typeof spec[0] === "number"
          ? z.union((spec as readonly number[]).map((v) => z.literal(v)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>])
          : z.enum(spec as unknown as [string, ...string[]])
        : spec === "boolean"
          ? z.boolean()
          : z.number()
    ).optional();
  }

  server.registerTool(
    "dcs_miz_set_mission_options",
    {
      title: "Set mission options",
      description:
        "Set mission date, start time and forced options (difficulty/realism settings that override each " +
        "player's own). Forced option keys are the ones the Mission Editor writes: permitCrash, " +
        "externalViews, optionsView ('optview_all'|'optview_onlymap'|…), labels (0 none … 4), easyFlight, " +
        "easyRadar, immortal, fuel (unlimited), weapons (unlimited), easyCommunication, radio, " +
        "unrestrictedSATNAV, padlock, wakeTurbulence, geffect ('none'|'reduced'|'realistic'), " +
        "accidental_failures, miniHUD, cockpitVisualRM, userMarks, civTraffic (''|'low'|'medium'|'high'), " +
        "birds, cockpitStatusBarAllowed, RBDAI. clearForcedOptions removes keys so player settings apply.\n\n" +
        "Args: sessionId, date? {year,month,day}, startTime? (seconds after midnight), forcedOptions?, " +
        "clearForcedOptions?\n\nReturns JSON: { changed: [fields] }.",
      inputSchema: z
        .object({
          sessionId: sessionIdField,
          date: z
            .object({
              year: z.number().int().min(1900).max(2100),
              month: z.number().int().min(1).max(12),
              day: z.number().int().min(1).max(31),
            })
            .strict()
            .optional(),
          startTime: z.number().int().min(0).max(86400).optional(),
          forcedOptions: z.object(forcedOptionShape).strict().optional(),
          clearForcedOptions: z
            .array(z.enum(Object.keys(FORCED_OPTIONS) as [ForcedOptionKey, ...ForcedOptionKey[]]))
            .optional(),
        })
        .strict(),
      outputSchema: z.object({ changed: z.array(z.string()) }),
      annotations: editAnnotations,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const changed = setMissionOptions(s.mission, {
          date: a.date,
          startTime: a.startTime,
          forcedOptions: a.forcedOptions as Record<ForcedOptionKey, boolean | number | string> | undefined,
          clearForcedOptions: a.clearForcedOptions,
        });
        touched(s);
        return buildResult(`Changed: ${changed.join(", ") || "nothing"}.`, { changed });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Listings that the editing tools need
  // -------------------------------------------------------------------------
  server.registerTool(
    "dcs_miz_list_triggers",
    {
      title: "List triggers",
      description:
        "List a mission's triggers: index, type, comment, whether a compiled runtime entry exists (an " +
        "uncompiled trigger does not fire when the .miz is flown), and the group/unit/zone/flag ids it " +
        "references.\n\nArgs: sessionId, response_format?\n\n" +
        "Returns JSON: { count, triggers: [{ index, predicate, comment, compiled, groupRefs, unitRefs, zoneRefs, flagRefs }] }.",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: z.object({ count: z.number(), triggers: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const triggers = s.document.triggers;
        return render(
          a.response_format,
          () => {
            if (!triggers.length) return "No triggers.";
            return [
              `# Triggers (${triggers.length})`,
              "",
              ...triggers.map(
                (t) =>
                  `- **#${t.index}** ${t.predicate}${t.comment ? ` — ${t.comment}` : ""}` +
                  `${t.compiled ? "" : " — NOT COMPILED (will not fire when flown)"}` +
                  (t.groupRefs.length ? `; groups ${t.groupRefs.join(",")}` : "") +
                  (t.unitRefs.length ? `; units ${t.unitRefs.join(",")}` : "") +
                  (t.zoneRefs.length ? `; zones ${t.zoneRefs.join(",")}` : "") +
                  (t.flagRefs.length ? `; flags ${t.flagRefs.join(",")}` : "")
              ),
            ].join("\n");
          },
          { count: triggers.length, triggers: triggers as unknown as Record<string, unknown>[] }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_list_zones",
    {
      title: "List trigger zones",
      description:
        "List a mission's trigger zones with id, position, radius and type.\n\nArgs: sessionId, response_format?\n\n" +
        "Returns JSON: { count, zones: [{ name, id, x, y, radius, type }] }.",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: z.object({ count: z.number(), zones: z.array(z.record(z.string(), z.unknown())) }),
      annotations: readOnly,
    },
    async (a) => {
      try {
        const s = requireSession(a.sessionId);
        const zones = s.document.zones;
        return render(
          a.response_format,
          () =>
            zones.length
              ? [
                  `# Trigger zones (${zones.length})`,
                  "",
                  ...zones.map(
                    (z) =>
                      `- **${z.name}** (id ${z.id ?? "?"}) ${z.type} at x=${z.x.toFixed(0)}, y=${z.y.toFixed(0)}` +
                      `${z.radius !== undefined ? `, r=${z.radius} m` : ""}`
                  ),
                ].join("\n")
              : "No trigger zones.",
          { count: zones.length, zones: zones as unknown as Record<string, unknown>[] }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
