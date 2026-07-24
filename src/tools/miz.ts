/** Offline `.miz` mission inspection tools (read-only, no running DCS required). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeSession, listSessions, openSession, requireSession } from "../miz/sessions.js";
import { validateMission } from "../miz/validator.js";
import {
  ResponseFormat,
  buildResult,
  errorResult,
  render,
  responseFormatField,
  validationReportSchema,
  weatherSchema,
} from "./format.js";

const sessionIdField = z
  .string()
  .min(1)
  .describe("Session id returned by dcs_miz_open (e.g. 'miz-1a2b3c4d')");

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const summarySchema = z.object({
  theatre: z.string(),
  start_time: z.number().optional(),
  date: z.object({ Year: z.number(), Month: z.number(), Day: z.number() }).optional(),
  coalitions: z.array(z.string()),
  countriesByCoalition: z.record(z.string(), z.array(z.string())),
  groupCount: z.number(),
  unitCount: z.number(),
  zoneCount: z.number(),
  triggerCount: z.number(),
  weather: weatherSchema,
  briefingTitle: z.string().optional(),
});

export function registerMizTools(server: McpServer): void {
  server.registerTool(
    "dcs_miz_open",
    {
      title: "Open DCS mission",
      description:
        "Open a DCS .miz mission file as a read-only session. The archive is validated for " +
        "safety (path traversal, zip-bomb limits) and parsed into a canonical model. The source " +
        "file is never modified.\n\nArgs:\n  - path (string): absolute path to a .miz file\n\n" +
        "Returns JSON: { sessionId, sourcePath, sourceDigest (sha256), theatre, groupCount, unitCount }.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Absolute path to a .miz mission file"),
      }).strict(),
      outputSchema: z.object({
        sessionId: z.string(),
        sourcePath: z.string(),
        sourceDigest: z.string(),
        theatre: z.string(),
        groupCount: z.number(),
        unitCount: z.number(),
      }),
      annotations: readOnly,
    },
    async ({ path }) => {
      try {
        const s = await openSession(path);
        const out = {
          sessionId: s.id,
          sourcePath: s.sourcePath,
          sourceDigest: s.document.sourceDigest,
          theatre: s.document.theatre,
          groupCount: s.document.summary.groupCount,
          unitCount: s.document.summary.unitCount,
        };
        return buildResult(
          `Opened '${path}' as session ${s.id} (theatre: ${s.document.theatre}, ` +
            `${out.groupCount} groups, ${out.unitCount} units).`,
          out
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_get_summary",
    {
      title: "Get mission summary",
      description:
        "Return mission metadata for an open session: theatre, date/time, coalitions and their " +
        "countries, group/unit/zone/trigger counts, weather, and briefing title.\n\n" +
        "Args:\n  - sessionId (string)\n  - response_format ('markdown' | 'json')",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: summarySchema,
      annotations: readOnly,
    },
    async ({ sessionId, response_format }) => {
      try {
        const { document } = requireSession(sessionId);
        const s = document.summary;
        return render(
          response_format,
          () => {
            const lines = [`# Mission Summary`, ``, `- **Theatre**: ${s.theatre}`];
            if (s.date) lines.push(`- **Date**: ${s.date.Year}-${s.date.Month}-${s.date.Day}`);
            if (s.start_time !== undefined) lines.push(`- **Start time**: ${s.start_time}s`);
            lines.push(`- **Coalitions**: ${s.coalitions.join(", ") || "none"}`);
            for (const [side, countries] of Object.entries(s.countriesByCoalition)) {
              lines.push(`  - ${side}: ${countries.join(", ")}`);
            }
            lines.push(
              `- **Groups**: ${s.groupCount}`,
              `- **Units**: ${s.unitCount}`,
              `- **Trigger zones**: ${s.zoneCount}`,
              `- **Triggers**: ${s.triggerCount}`
            );
            if (s.briefingTitle) lines.push(`- **Briefing**: ${s.briefingTitle}`);
            return lines.join("\n");
          },
          s as unknown as Record<string, unknown>
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_list_groups",
    {
      title: "List mission groups",
      description:
        "List groups in an open mission, optionally filtered by coalition or category. Each entry " +
        "includes name, coalition, country, category, task, unit count/types, and waypoint count.\n\n" +
        "Args:\n  - sessionId (string)\n  - coalition ('red'|'blue'|'neutrals', optional)\n" +
        "  - category ('plane'|'helicopter'|'ship'|'vehicle'|'static', optional)\n" +
        "  - response_format ('markdown' | 'json')",
      inputSchema: z.object({
        sessionId: sessionIdField,
        coalition: z.enum(["red", "blue", "neutrals"]).optional().describe("Filter by coalition"),
        category: z
          .enum(["plane", "helicopter", "ship", "vehicle", "static"])
          .optional()
          .describe("Filter by group category"),
        response_format: responseFormatField,
      }).strict(),
      outputSchema: z.object({
        count: z.number(),
        groups: z.array(
          z.object({
            name: z.string(),
            coalition: z.string(),
            country: z.string(),
            category: z.string(),
            task: z.string().optional(),
            unitCount: z.number(),
            unitTypes: z.array(z.string()),
            waypointCount: z.number(),
          })
        ),
      }),
      annotations: readOnly,
    },
    async ({ sessionId, coalition, category, response_format }) => {
      try {
        const { document } = requireSession(sessionId);
        const groups = document.groups.filter(
          (g) => (!coalition || g.coalition === coalition) && (!category || g.category === category)
        );
        const structured = {
          count: groups.length,
          groups: groups.map((g) => ({
            name: g.name,
            coalition: g.coalition,
            country: g.country,
            category: g.category,
            task: g.task,
            unitCount: g.units.length,
            unitTypes: [...new Set(g.units.map((u) => u.type))],
            waypointCount: g.waypointCount,
          })),
        };
        return render(
          response_format,
          () => {
            if (!groups.length) return "No groups match the given filters.";
            const lines = [`# Groups (${groups.length})`, ``];
            for (const g of groups) {
              lines.push(
                `## ${g.name} (${g.coalition}/${g.category})`,
                `- Country: ${g.country}${g.task ? ` | Task: ${g.task}` : ""}`,
                `- Units: ${g.units.length} [${[...new Set(g.units.map((u) => u.type))].join(", ")}]`,
                `- Waypoints: ${g.waypointCount}`,
                ``
              );
            }
            return lines.join("\n");
          },
          structured
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_get_weather",
    {
      title: "Get mission weather",
      description:
        "Return the weather configuration of an open mission: temperature, QNH, cloud base, and " +
        "ground wind.\n\nArgs:\n  - sessionId (string)\n  - response_format ('markdown' | 'json')",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: weatherSchema,
      annotations: readOnly,
    },
    async ({ sessionId, response_format }) => {
      try {
        const { document } = requireSession(sessionId);
        const w = document.weather;
        return render(
          response_format,
          () =>
            [
              `# Weather`,
              ``,
              `- Temperature: ${w.temperatureCelsius ?? "?"} °C`,
              `- QNH: ${w.qnhMmHg ?? "?"} mmHg`,
              `- Cloud base: ${w.cloudsBase ?? "?"} m`,
              `- Ground wind: ${w.windGroundSpeed ?? "?"} m/s @ ${w.windGroundDir ?? "?"}°`,
              `- Turbulence: ${w.turbulence ?? "?"}`,
            ].join("\n"),
          w as unknown as Record<string, unknown>
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_get_briefing",
    {
      title: "Get mission briefing",
      description:
        "Return the mission briefing (title and description text), resolved through the mission " +
        "localization dictionary.\n\nArgs:\n  - sessionId (string)\n  - response_format ('markdown' | 'json')",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: z.object({
        title: z.string().optional(),
        description: z.string().optional(),
      }),
      annotations: readOnly,
    },
    async ({ sessionId, response_format }) => {
      try {
        const { document } = requireSession(sessionId);
        const b = document.briefing;
        return render(
          response_format,
          () =>
            [`# ${b.title ?? "(untitled mission)"}`, ``, b.description ?? "(no description)"].join("\n"),
          b as unknown as Record<string, unknown>
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_validate",
    {
      title: "Validate mission",
      description:
        "Run read-only structural validation over an open mission: duplicate group/unit/zone names, " +
        "empty groups, missing unit types, zone radii, and QNH sanity. Distinguishes errors from " +
        "warnings.\n\nArgs:\n  - sessionId (string)\n  - response_format ('markdown' | 'json')\n\n" +
        "Returns JSON: { ok, errors: [...], warnings: [...] }.",
      inputSchema: z.object({ sessionId: sessionIdField, response_format: responseFormatField }).strict(),
      outputSchema: validationReportSchema,
      annotations: readOnly,
    },
    async ({ sessionId, response_format }) => {
      try {
        const { document } = requireSession(sessionId);
        const report = validateMission(document);
        return render(
          response_format,
          () => {
            const lines = [`# Validation: ${report.ok ? "PASS" : "FAIL"}`, ``];
            if (report.errors.length) {
              lines.push(`## Errors (${report.errors.length})`);
              for (const e of report.errors) lines.push(`- [${e.code}] ${e.message}`);
              lines.push(``);
            }
            if (report.warnings.length) {
              lines.push(`## Warnings (${report.warnings.length})`);
              for (const w of report.warnings) lines.push(`- [${w.code}] ${w.message}`);
            }
            if (!report.errors.length && !report.warnings.length) lines.push("No issues found.");
            return lines.join("\n");
          },
          report as unknown as Record<string, unknown>
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_miz_list_sessions",
    {
      title: "List open mission sessions",
      description:
        "List every mission session currently open in this server, with the source file (if any), " +
        "when it was opened, whether it has unsaved changes, and its group/unit counts. Use this to " +
        "recover a sessionId you no longer have.\n\nArgs:\n  - response_format ('markdown' | 'json')\n\n" +
        "Returns JSON: { count, sessions: [{ sessionId, sourcePath, openedAt, dirty, theatre, groupCount, unitCount }] }.",
      inputSchema: z.object({ response_format: responseFormatField }).strict(),
      outputSchema: z.object({
        count: z.number(),
        sessions: z.array(
          z.object({
            sessionId: z.string(),
            sourcePath: z.string().optional(),
            openedAt: z.string(),
            dirty: z.boolean(),
            theatre: z.string(),
            groupCount: z.number(),
            unitCount: z.number(),
          })
        ),
      }),
      annotations: readOnly,
    },
    async ({ response_format }) => {
      const sessions = listSessions().map((s) => ({
        sessionId: s.id,
        ...(s.sourcePath ? { sourcePath: s.sourcePath } : {}),
        openedAt: s.openedAt,
        dirty: s.dirty,
        theatre: s.document.theatre,
        groupCount: s.document.summary.groupCount,
        unitCount: s.document.summary.unitCount,
      }));
      const structured = { count: sessions.length, sessions };
      return render(
        response_format,
        () => {
          if (!sessions.length) return "No open sessions. Use dcs_miz_open or dcs_miz_new to start one.";
          const lines = [`# Open sessions (${sessions.length})`, ``];
          for (const s of sessions) {
            lines.push(
              `- **${s.sessionId}** (${s.theatre}) - ${s.groupCount} groups, ${s.unitCount} units` +
                `${s.dirty ? " — unsaved changes" : ""}`,
              `  - Source: ${s.sourcePath ?? "(new mission, never saved)"}`,
              `  - Opened: ${s.openedAt}`
            );
          }
          return lines.join("\n");
        },
        structured
      );
    }
  );

  server.registerTool(
    "dcs_miz_close",
    {
      title: "Close mission session",
      description:
        "Close an open mission session and free its parsed data. Unsaved changes are discarded; save " +
        "first with dcs_miz_save_as if you want to keep them.\n\nArgs:\n  - sessionId (string)\n\n" +
        "Returns JSON: { closed, openSessions }.",
      inputSchema: z.object({ sessionId: sessionIdField }).strict(),
      outputSchema: z.object({ closed: z.boolean(), openSessions: z.array(z.string()) }),
      // Discards in-memory state, so not read-only; closing twice is harmless.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }) => {
      const removed = closeSession(sessionId);
      const open = listSessions().map((s) => s.id);
      return buildResult(
        removed ? `Closed session ${sessionId}.` : `No open session '${sessionId}'.`,
        { closed: removed, openSessions: open }
      );
    }
  );
}
