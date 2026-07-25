/**
 * Reading DCS's own log.
 *
 * The live bridge only exists while a mission is running, but DCS reports its
 * problems to `Saved Games/DCS/Logs/dcs.log` at every stage — startup, Mission
 * Editor load, mission start, and while flying. That makes the log the only
 * error channel that is always available, and the one that catches the failures
 * that matter most here: a generated `.miz` the Mission Editor refuses to open,
 * or a mission script that blows up on load.
 *
 * Read-only. Nothing here writes to or truncates the user's log.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** A DCS log line, parsed. */
export interface LogEntry {
  /** Line number in the file, 1-based. */
  line: number;
  timestamp: string;
  level: "ALERT" | "ERROR" | "WARNING" | "INFO" | "DEBUG";
  /** DCS subsystem, e.g. `LUACOMMON`, `Scripting`, `APP`. */
  source: string;
  message: string;
  /** Continuation lines (stack tracebacks) that belong to this entry. */
  detail?: string[];
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(ALERT|ERROR|WARNING|INFO|DEBUG)\s+(\S+)\s*(?:\([^)]*\))?:\s?(.*)$/;

/** Default log location for a stock install. */
export function defaultLogPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return path.join(home, "Saved Games", "DCS", "Logs", "dcs.log");
}

/**
 * Parse the log into entries, folding stack-traceback continuation lines into
 * the entry above them — a Lua error is useless without its traceback.
 */
export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const m = LINE_RE.exec(raw);
    if (m) {
      entries.push({
        line: i + 1,
        timestamp: m[1],
        level: m[2] as LogEntry["level"],
        source: m[3],
        message: m[4],
      });
      continue;
    }
    // Not a new entry: a traceback or wrapped message belonging to the last one.
    const last = entries[entries.length - 1];
    if (last && raw.trim().length > 0) (last.detail ??= []).push(raw);
  }
  return entries;
}

/**
 * Problems worth surfacing. DCS logs a lot of routine ERROR noise at startup
 * (missing optional units, unsupported demo mods), so the interesting entries
 * are the ones that indicate something actually failed to work.
 */
const PROBLEM_LEVELS = new Set<LogEntry["level"]>(["ALERT", "ERROR"]);

/**
 * Startup chatter that is normal on a healthy install and drowns real errors.
 * `wInfo` in particular logs an ERROR per questionable weapon-drag value in
 * every installed module — over a hundred lines on a stock install.
 */
const BENIGN_SOURCES = new Set(["wInfo", "EDOBJECTS", "SECURITYCONTROL"]);
const BENIGN_MESSAGES = [
  /^plugin: SKIPPED/i,
  /^unit \S+ not found$/i,
  /^Can't open file/i,
  /^negative drag of payload/i,
  // Per-unit definition complaints from installed modules: logged on every
  // start, unrelated to whatever mission is being worked on.
  /^Error: Unit \[[^\]]+\]: Effect presets records are defined but empty/i,
  /^Error: Unit \[[^\]]+\]: Asymmetrical wing configuration/i,
  /Unexpected fires_pos index/i,
  // Map load chatter: missing prop/light models, destroyed-model fallbacks, and
  // navaid/ATC definition gaps in the terrain — none of it mission-authored.
  /^Can't open model /i,
  /^can't load destroyed model /i,
  /^Invalid DME frequency/i,
  /^INVALID ATC /i,
  /^Unable to find beacon with ID:/i,
  // Optional-module probing at startup: DCS tries many entry-point paths that a
  // given install simply doesn't have.
  /^loadfile: no file /i,
  /^No suitable driver found to mount /i,
  // DCS-gRPC's own hook fails to init when its native DLL isn't loaded, and it
  // does so once per frame — a flood unrelated to anything here. Path-anchored so
  // it never hides our own Hooks/dcs-mcp-hook.lua, which is a different file.
  /\bDCS-gRPC[\/\\]grpc\.lua/i,
];

export interface LogProblem extends LogEntry {
  /** Set when the entry looks like a Lua failure with a traceback. */
  lua?: boolean;
  /** Mission or script file the entry blames, when one can be identified. */
  blames?: string[];
}

const LUA_HINT = /attempt to |stack traceback|\[string "|:\d+: in function|Mission script error|SCRIPTING ERROR|GUI Error/i;
const FILE_RE = /\[string "([^"]+)"\]/g;

/** Pull out the entries that indicate something went wrong. */
export function findProblems(entries: LogEntry[]): LogProblem[] {
  const out: LogProblem[] = [];
  for (const entry of entries) {
    const body = [entry.message, ...(entry.detail ?? [])].join("\n");
    const isLua = LUA_HINT.test(body);
    if (!PROBLEM_LEVELS.has(entry.level) && !isLua) continue;
    // A Lua failure is always worth showing, even from a normally noisy source.
    if (!isLua && BENIGN_SOURCES.has(entry.source)) continue;
    if (BENIGN_MESSAGES.some((re) => re.test(entry.message))) continue;

    const blames = [...body.matchAll(FILE_RE)].map((m) => m[1]);
    out.push({ ...entry, lua: isLua || undefined, blames: blames.length ? [...new Set(blames)] : undefined });
  }
  return out;
}

export interface LogReadOptions {
  logPath?: string;
  /** Only entries at or after this timestamp (`YYYY-MM-DD HH:MM:SS.mmm`). */
  since?: string;
  /** Only entries at or after this line number. */
  sinceLine?: number;
  /** Cap on returned problems, newest kept. */
  limit?: number;
}

export interface LogReadResult {
  logPath: string;
  /** When the log file was last written — how fresh this information is. */
  modified: string;
  /** Total lines in the file, for use as `sinceLine` on the next call. */
  lines: number;
  /** The session the log belongs to, from its `=== Log opened` header. */
  sessionStarted?: string;
  problems: LogProblem[];
  /** Problems found before `limit` was applied. */
  totalProblems: number;
}

/**
 * Read the DCS log and return what looks like a problem.
 *
 * The log can be tens of megabytes after a long session, so only the tail is
 * parsed unless a caller asks for more.
 */
export async function readLogProblems(options: LogReadOptions = {}): Promise<LogReadResult> {
  const logPath = options.logPath ?? defaultLogPath();
  const info = await stat(logPath).catch(() => undefined);
  if (!info) {
    throw new Error(
      `DCS log not found at '${logPath}'. Pass logPath explicitly if DCS uses a different Saved Games folder.`
    );
  }

  const text = await readFile(logPath, "utf8");
  const entries = parseLog(text);
  const header = /^=== Log opened UTC (.+)$/m.exec(text);

  let selected = entries;
  if (options.sinceLine !== undefined) {
    selected = selected.filter((e) => e.line >= options.sinceLine!);
  }
  if (options.since) {
    selected = selected.filter((e) => e.timestamp >= options.since!);
  }

  const problems = findProblems(selected);
  const limit = options.limit ?? 50;
  return {
    logPath,
    modified: info.mtime.toISOString(),
    lines: text.split(/\r?\n/).length,
    sessionStarted: header?.[1],
    problems: problems.slice(-limit),
    totalProblems: problems.length,
  };
}

/**
 * Whether DCS looks like it is running, judged by how recently it wrote its log.
 * DCS writes continuously, so a log that has been quiet for a while means the
 * process is gone or wedged.
 */
export async function logFreshness(logPath = defaultLogPath()): Promise<{
  exists: boolean;
  modified?: string;
  ageSeconds?: number;
}> {
  const info = await stat(logPath).catch(() => undefined);
  if (!info) return { exists: false };
  return {
    exists: true,
    modified: info.mtime.toISOString(),
    ageSeconds: Math.round((Date.now() - info.mtimeMs) / 1000),
  };
}
