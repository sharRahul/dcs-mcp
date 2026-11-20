/**
 * Register this server with the Claude Desktop app by merging an entry into
 * `claude_desktop_config.json`.
 *
 * Hand-editing that file is the most common setup failure: it also holds the
 * app's own `preferences` block, so a rewrite loses settings; a trailing comma
 * makes Claude Desktop start with no MCP servers at all and say nothing; and on
 * Windows the app spawns the command WITHOUT a shell, so a bare `npx` (which is
 * `npx.cmd`) fails with ENOENT. This merges into the existing JSON, keeps a
 * backup, and writes a command shape that works on each platform.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PACKAGE_ROOT } from "../paths.js";

/** `local` runs this checkout/install; `published` runs the npm package through npx. */
export type EntryMode = "local" | "published";

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type ConfigureStatus =
  | "added"
  | "unchanged"
  | "replaced"
  | "differs"
  | "would-add"
  | "would-replace";

export interface ConfigureOptions {
  /** Explicit config file; otherwise the platform default. */
  configPath?: string;
  /** Default `local`; `published` is never chosen for you (see resolveMode). */
  mode?: EntryMode;
  /** Key under `mcpServers`. */
  serverName?: string;
  /** Environment variables to write into the entry (empty values are dropped). */
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
  /** Replace an existing entry that differs (the old file is backed up). */
  overwrite?: boolean;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  /** Node executable for `local` mode. Defaults to the running one. */
  nodePath?: string;
  /** Entry script for `local` mode. Defaults to this package's dist/index.js. */
  entryScript?: string;
}

export interface ConfigureResult {
  configPath: string;
  serverName: string;
  mode: EntryMode;
  status: ConfigureStatus;
  entry: ServerEntry;
  /** Where the previous config was copied when one was replaced. */
  backup?: string;
  notes: string[];
}

/** Where Claude Desktop keeps its MCP config, per platform. */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const file = "claude_desktop_config.json";
  if (platform === "win32") {
    const appData = env.APPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : "");
    if (!appData) throw new Error("APPDATA is not set; pass the config path explicitly.");
    return path.join(appData, "Claude", file);
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("HOME is not set; pass the config path explicitly.");
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", file);
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude", file);
}

/** The compiled entry point of this package, whether run from src/ (tsx) or dist/. */
export function defaultEntryScript(): string {
  return path.join(PACKAGE_ROOT, "dist", "index.js");
}

/**
 * True when the entry script sits in a throwaway location. `npx` unpacks the
 * package under a cache directory it may clear at any time, so pinning Claude
 * Desktop to that path produces a server that works today and is gone tomorrow.
 */
export function isEphemeralPath(file: string): boolean {
  const parts = path.resolve(file).split(/[\\/]/);
  return parts.includes("_npx") || parts.includes(".npm-cache") || parts.includes("_cacache");
}

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * `local` unless `published` was asked for explicitly. There is deliberately no
 * fallback: the npm package has no release yet, so quietly writing the `npx`
 * entry because `dist/` was missing would leave the app with a server it cannot
 * start and no explanation. An unusable local script is reported instead.
 */
function resolveMode(options: ConfigureOptions): EntryMode {
  return options.mode ?? "local";
}

/** The `mcpServers` entry for a mode. Windows gets `cmd /c` so `npx.cmd` resolves. */
export function serverEntry(options: ConfigureOptions = {}): ServerEntry {
  const platform = options.platform ?? process.platform;
  const env = cleanEnv(options.env);
  const mode = resolveMode(options);
  if (mode === "published") {
    const published: ServerEntry =
      platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", "-y", "dcs-sortie-mcp"] }
        : { command: "npx", args: ["-y", "dcs-sortie-mcp"] };
    return env ? { ...published, env } : published;
  }
  const local: ServerEntry = {
    command: options.nodePath ?? process.execPath,
    args: [options.entryScript ?? defaultEntryScript()],
  };
  return env ? { ...local, env } : local;
}

function sameEntry(a: unknown, b: ServerEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Merge the entry into `claude_desktop_config.json`, keeping everything else. */
export async function configureClaudeDesktop(options: ConfigureOptions = {}): Promise<ConfigureResult> {
  const platform = options.platform ?? process.platform;
  const configPath =
    options.configPath ?? claudeDesktopConfigPath(platform, options.processEnv ?? process.env);
  const serverName = options.serverName ?? "dcs";
  const mode = resolveMode(options);
  const entry = serverEntry({ ...options, mode });
  const notes: string[] = [];

  if (mode === "local") {
    const script = options.entryScript ?? defaultEntryScript();
    // Shape first, existence second: an npx-cache path usually DOES exist right now.
    if (isEphemeralPath(script)) {
      throw new Error(
        `'${script}' is inside a package cache that may be cleared. Build a permanent clone ` +
          "and run its installer with --local. Use --published only after the npm package is released."
      );
    }
    if (!existsSync(script)) {
      throw new Error(`'${script}' does not exist. Run 'npm ci' and 'npm run build' in your permanent clone first; nothing was changed.`);
    }
  }

  let raw: string | undefined;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    raw = undefined;
  }

  let config: Record<string, unknown> = {};
  if (raw !== undefined && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("the top level is not a JSON object");
      }
      config = parsed as Record<string, unknown>;
    } catch (error) {
      // Never overwrite a file we cannot read: it holds the user's own app settings.
      throw new Error(
        `'${configPath}' is not valid JSON (${(error as Error).message}). Fix or move it, then re-run; ` +
          "nothing was changed."
      );
    }
  }

  const servers = config.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new Error(`'${configPath}' has an 'mcpServers' value that is not an object; nothing was changed.`);
  }
  const existingServers: Record<string, unknown> =
    servers && typeof servers === "object" ? { ...(servers as Record<string, unknown>) } : {};

  const previous = existingServers[serverName];
  if (previous !== undefined && sameEntry(previous, entry)) {
    return { configPath, serverName, mode, status: "unchanged", entry, notes };
  }
  if (previous !== undefined && !options.overwrite) {
    notes.push(
      `'${serverName}' already exists in ${configPath} and points somewhere else. Nothing was changed. ` +
        "Re-run with --force to replace it (the old file is kept as a .bak), or pass --name <other>."
    );
    return { configPath, serverName, mode, status: "differs", entry, notes };
  }
  if (options.dryRun) {
    return {
      configPath,
      serverName,
      mode,
      status: previous === undefined ? "would-add" : "would-replace",
      entry,
      notes,
    };
  }

  existingServers[serverName] = entry;
  // Spread the file first so every other key (the app's own preferences) keeps its place.
  const merged: Record<string, unknown> = { ...config, mcpServers: existingServers };

  let backup: string | undefined;
  if (raw !== undefined) {
    backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(configPath, backup);
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  notes.push("Quit Claude Desktop completely and start it again: the config is read at startup.");
  notes.push(
    "Then ask it to list the DCS tools, or call dcs_status. For live control of a running DCS, " +
      "install the hook as well: ask the connected assistant to run dcs_install_hook."
  );
  if (mode === "published") {
    notes.push("The first start downloads the published package, so it needs internet access.");
  }
  return {
    configPath,
    serverName,
    mode,
    status: previous === undefined ? "added" : "replaced",
    entry,
    backup,
    notes,
  };
}
