/**
 * Always-available DCS diagnostics.
 *
 * The live bridge is the richest channel but it needs DCS running with the hook
 * loaded. `Saved Games/DCS/Logs/dcs.log` needs neither, and it is where DCS
 * records the failures that matter most when authoring missions: a `.miz` the
 * Mission Editor refuses to open, or a mission script that errors on load. These
 * tools read both and never fail just because DCS is not up.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeRequest } from "../bridge/client.js";
import { defaultLogPath, logFreshness, readLogProblems, type LogProblem } from "../dcs/log.js";
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from "../constants.js";
import { buildResult, errorResult } from "./format.js";
import { findSavedGamesDirs, installHook } from "../dcs/install.js";

const hostField = z.string().default(BRIDGE_DEFAULT_HOST).describe("Bridge host");
const portField = z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT).describe("Bridge port");
const logPathField = z
  .string()
  .optional()
  .describe(`Path to dcs.log (default: ${defaultLogPath()})`);

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** One line per problem, newest last, with the traceback kept but trimmed. */
function renderProblems(problems: LogProblem[]): string {
  if (problems.length === 0) return "No problems found.";
  return problems
    .map((p) => {
      const head = `${p.timestamp} ${p.level} ${p.source}: ${p.message}`;
      const blame = p.blames?.length ? `\n    blames: ${p.blames.join(", ")}` : "";
      const detail = p.detail?.length
        ? `\n${p.detail.slice(0, 12).map((d) => `    ${d.trim()}`).join("\n")}`
        : "";
      return `- ${head}${blame}${detail}`;
    })
    .join("\n");
}

export function registerDiagnosticTools(server: McpServer): void {
  server.registerTool(
    "dcs_status",
    {
      title: "DCS status",
      description:
        "One call that answers 'is DCS up, is the bridge reachable, and has anything gone wrong'. " +
        "Never fails just because DCS is closed — it falls back to the log.\n\n" +
        "The live bridge needs DCS running with scripts/Hooks/dcs-mcp-hook.lua installed. " +
        "`phase` tells you what DCS is doing (menu / loading / loaded / running) and `missionEnv` " +
        "whether the mission scripting environment is reachable — the unit/spawn/message tools need " +
        "a mission actually running.\n\n" +
        "Args: host?, port?, logPath?, problemLimit?\n\n" +
        "Returns JSON: { bridge: { reachable, phase?, mission?, missionEnv?, error? }, " +
        "log: { exists, modified, ageSeconds, sessionStarted, totalProblems }, problems: [...] }.",
      inputSchema: z
        .object({
          host: hostField,
          port: portField,
          logPath: logPathField,
          problemLimit: z.number().int().min(1).max(200).default(10),
        })
        .strict(),
      outputSchema: z.object({
        bridge: z.object({
          reachable: z.boolean(),
          listening: z.boolean().optional(),
          phase: z.string().optional(),
          mission: z.string().optional(),
          missionEnv: z.boolean().optional(),
          errorCount: z.number().optional(),
          error: z.string().optional(),
        }),
        log: z.object({
          exists: z.boolean(),
          path: z.string(),
          modified: z.string().optional(),
          ageSeconds: z.number().optional(),
          sessionStarted: z.string().optional(),
          totalProblems: z.number().optional(),
          lines: z.number().optional(),
        }),
        problems: z.array(z.unknown()),
      }),
      annotations: readOnly,
    },
    async ({ host, port, logPath, problemLimit }) => {
      try {
        // Bridge first, but a failure here is information, not an error: DCS may
        // simply not be running.
        const bridge: Record<string, unknown> = { reachable: false };
        try {
          // `status` is newer than the hook's original command set; fall back to
          // `ping` so an older installed hook still reports as reachable.
          let data: any;
          try {
            data = await bridgeRequest({ cmd: "status" }, { host, port });
          } catch {
            await bridgeRequest({ cmd: "ping" }, { host, port });
            data = { listening: true };
          }
          Object.assign(bridge, { reachable: true }, data ?? {});
        } catch (err) {
          bridge.error = err instanceof Error ? err.message : String(err);
        }

        const freshness = await logFreshness(logPath);
        const log: Record<string, unknown> = {
          exists: freshness.exists,
          path: logPath ?? defaultLogPath(),
          modified: freshness.modified,
          ageSeconds: freshness.ageSeconds,
        };

        let problems: LogProblem[] = [];
        if (freshness.exists) {
          const read = await readLogProblems({ logPath, limit: problemLimit });
          log.sessionStarted = read.sessionStarted;
          log.totalProblems = read.totalProblems;
          log.lines = read.lines;
          problems = read.problems;
        }

        const bridgeLine = bridge.reachable
          ? `Bridge: connected (phase=${bridge.phase ?? "unknown"}, missionEnv=${bridge.missionEnv ?? "unknown"})`
          : `Bridge: NOT reachable at ${host}:${port} — ${bridge.error}`;
        const logLine = freshness.exists
          ? `Log: ${log.path} (written ${freshness.ageSeconds}s ago, ${log.totalProblems} problem(s))`
          : `Log: not found at ${log.path}`;

        return buildResult(
          `${bridgeLine}\n${logLine}\n\n## Recent problems\n${renderProblems(problems)}`,
          { bridge, log, problems }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_get_log_errors",
    {
      title: "Read DCS log errors",
      description:
        "Read errors and Lua failures out of dcs.log. This is the channel that catches a generated " +
        ".miz the Mission Editor cannot open, or a mission script that fails on load — neither of " +
        "which the live bridge can see.\n\n" +
        "Routine startup noise (skipped plugins, missing optional units) is filtered out. Stack " +
        "tracebacks are attached to the entry they belong to, and `blames` lists the Lua files named " +
        "in them.\n\n" +
        "Pass `sinceLine` from a previous call's `lines` to see only what is new.\n\n" +
        "Args: logPath?, since? ('YYYY-MM-DD HH:MM:SS.mmm'), sinceLine?, limit?\n\n" +
        "Returns JSON: { logPath, modified, lines, sessionStarted, totalProblems, problems: [...] }.",
      inputSchema: z
        .object({
          logPath: logPathField,
          since: z
            .string()
            .optional()
            .describe("Only entries at or after this DCS timestamp, e.g. '2026-07-24 23:51:00.000'"),
          sinceLine: z.number().int().min(1).optional().describe("Only entries at or after this line number"),
          limit: z.number().int().min(1).max(200).default(30),
        })
        .strict(),
      outputSchema: z.object({
        logPath: z.string(),
        modified: z.string(),
        lines: z.number(),
        sessionStarted: z.string().optional(),
        totalProblems: z.number(),
        problems: z.array(z.unknown()),
      }),
      annotations: readOnly,
    },
    async ({ logPath, since, sinceLine, limit }) => {
      try {
        const result = await readLogProblems({ logPath, since, sinceLine, limit });
        return buildResult(
          `# DCS log problems (${result.totalProblems} total, showing ${result.problems.length})\n\n` +
            `Log: ${result.logPath}\nSession opened: ${result.sessionStarted ?? "unknown"}\n` +
            `File is ${result.lines} lines — pass sinceLine=${result.lines} next time for only new entries.\n\n` +
            renderProblems(result.problems),
          result as unknown as Record<string, unknown>
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_install_hook",
    {
      title: "Install live hook",
      description:
        "Install the live-control hook (scripts/Hooks/dcs-mcp-hook.lua) into a DCS Saved Games " +
        "profile, creating Scripts/Hooks if needed. Optionally also copies the in-mission telemetry " +
        "script to Scripts/ so dcs_miz_load_scripts can embed it.\n\n" +
        "With no savedGames it lists the candidate profiles (Saved Games/DCS, DCS.openbeta, DCS.server, " +
        "or $DCS_SAVED_GAMES) and installs only when exactly one exists. A target that differs from the " +
        "bundled copy (an older release, or local edits like ALLOW_EXEC) is left alone unless " +
        "overwrite=true; a replaced file is kept as a .bak. DCS must be restarted afterwards.\n\n" +
        "Args: savedGames?, telemetry? (default false), overwrite? (default false), dryRun? (default false)\n\n" +
        "Returns JSON: { candidates, result?: { savedGames, files: [{ file, target, status, backup? }], " +
        "restartRequired, notes } }.",
      inputSchema: z
        .object({
          savedGames: z
            .string()
            .optional()
            .describe("DCS Saved Games profile folder, e.g. C:\\Users\\me\\Saved Games\\DCS"),
          telemetry: z.boolean().default(false).describe("Also install dcs-mcp-telemetry.lua"),
          overwrite: z.boolean().default(false).describe("Replace a differing installed copy (backed up)"),
          dryRun: z.boolean().default(false).describe("Report what would change without writing"),
        })
        .strict(),
      outputSchema: z.object({
        candidates: z.array(z.object({ path: z.string(), looksLikeDcs: z.boolean() })),
        result: z
          .object({
            savedGames: z.string(),
            files: z.array(
              z.object({ file: z.string(), target: z.string(), status: z.string(), backup: z.string().optional() })
            ),
            restartRequired: z.boolean(),
            notes: z.array(z.string()),
          })
          .optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ savedGames, telemetry, overwrite, dryRun }) => {
      try {
        const candidates = findSavedGamesDirs();
        let target = savedGames;
        if (!target) {
          if (candidates.length !== 1) {
            const listing = candidates.map((c) => `- ${c.path}${c.looksLikeDcs ? "" : " (no Config/Logs)"}`);
            return buildResult(
              candidates.length === 0
                ? "No DCS Saved Games folder found. Pass savedGames explicitly (or set DCS_SAVED_GAMES)."
                : `Several DCS profiles found; pass savedGames to choose one:\n${listing.join("\n")}`,
              { candidates }
            );
          }
          target = candidates[0].path;
        }
        const result = await installHook({ savedGames: target, telemetry, overwrite, dryRun });
        const lines = result.files.map(
          (f) => `- ${f.file}: ${f.status} → ${f.target}${f.backup ? ` (previous kept at ${f.backup})` : ""}`
        );
        return buildResult([`# Hook install (${result.savedGames})`, ...lines, "", ...result.notes].join("\n"), {
          candidates,
          result: result as unknown as Record<string, unknown>,
        } as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
