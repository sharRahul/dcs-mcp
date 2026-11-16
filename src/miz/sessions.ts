/**
 * In-memory mission sessions.
 *
 * A session holds the raw parsed `mission` table (mutated in place by authoring
 * tools, preserving unsupported fields), the original archive bytes (so save is
 * copy-on-write and lossless), and a derived canonical document for reads.
 * The source `.miz` on disk is never modified.
 *
 * When persistence is enabled (the server does so at startup) every session is
 * snapshotted to a state directory after each change, so a client or server
 * restart does not lose a long authoring run: `listSnapshots` shows what can be
 * brought back and `restoreSession` reloads it under the same id. Snapshots are
 * plain files — the source archive bytes once, the three Lua tables on every
 * change, embedded resources as they are added — and go through the same
 * serializer/parser round trip as a saved .miz.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { assertSafeEntryName } from "../security/archive-policy.js";
import { packMiz, readMizArchive } from "./archive.js";
import { buildMissionDocument, parseMissionTables } from "./parser.js";
import { serializeLuaAssignment } from "./serializer.js";
import { newMissionTable } from "./authoring.js";
import { assertSafeResourceName } from "./resources.js";
import { L10N_PREFIX } from "../constants.js";
import { parseLuaAssignment, type LuaTable } from "./lua.js";
import type { MissionDocument } from "../types.js";

export interface MissionSession {
  id: string;
  sourcePath?: string;
  openedAt: string;
  mission: LuaTable;
  /** Set only when logistics is edited; otherwise retain the original archive member verbatim. */
  warehouses?: LuaTable;
  archiveFiles?: Map<string, Buffer>;
  removedEntries?: Set<string>;
  dictionary: LuaTable;
  /** `l10n/DEFAULT/mapResource`: resource key -> embedded file name. */
  mapResource: LuaTable;
  /** Files to embed under `l10n/DEFAULT/` on save, keyed by bare file name. */
  files: Map<string, Buffer>;
  sourceBytes: Buffer;
  document: MissionDocument;
  /** Snapshot of the document when the session was opened/created, for diffing. */
  baseline: MissionDocument;
  dirty: boolean;
}

const sessions = new Map<string, MissionSession>();

function newId(): string {
  return `miz-${randomUUID().slice(0, 8)}`;
}

function digestOf(mission: LuaTable): string {
  return createHash("sha256").update(serializeLuaAssignment("mission", mission)).digest("hex");
}

/** Recompute the derived document after a mutation, and snapshot the session. */
export function refresh(session: MissionSession): void {
  session.document = buildMissionDocument(session.mission, session.dictionary, digestOf(session.mission));
  snapshot(session);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let stateDir: string | undefined;

/** Snapshots older than this are pruned when persistence is enabled. */
const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

interface SnapshotMeta {
  id: string;
  sourcePath?: string;
  openedAt: string;
  updatedAt: string;
  dirty: boolean;
  theatre: string;
  groupCount: number;
  baseline: MissionDocument;
}

/**
 * Turn on snapshotting. `dir` defaults to `$DCS_MCP_STATE_DIR`, else
 * `<tmp>/dcs-mcp-sessions`; the value "off" disables it. Returns the directory
 * in use, or undefined when disabled.
 */
export function enableSessionPersistence(dir?: string): string | undefined {
  const chosen = dir ?? process.env.DCS_MCP_STATE_DIR ?? path.join(tmpdir(), "dcs-mcp-sessions");
  if (chosen === "off" || chosen === "0" || chosen === "") {
    stateDir = undefined;
    return undefined;
  }
  mkdirSync(chosen, { recursive: true });
  stateDir = chosen;
  const now = Date.now();
  for (const entry of readdirSync(chosen)) {
    const full = path.join(chosen, entry);
    try {
      if (now - statSync(full).mtimeMs > SNAPSHOT_MAX_AGE_MS) rmSync(full, { recursive: true, force: true });
    } catch {
      // A snapshot we cannot stat is not worth failing startup over.
    }
  }
  return stateDir;
}

export function sessionStateDir(): string | undefined {
  return stateDir;
}

function snapshotDir(id: string): string | undefined {
  if (!stateDir || !/^miz-[0-9a-f]{8}$/.test(id)) return undefined;
  return path.join(stateDir, id);
}

/** Write the session's current state. Never throws: persistence is best effort. */
function snapshot(session: MissionSession): void {
  const dir = snapshotDir(session.id);
  if (!dir) return;
  try {
    mkdirSync(path.join(dir, "files"), { recursive: true });
    const source = path.join(dir, "source.miz");
    if (!existsSync(source)) writeFileSync(source, session.sourceBytes);
    writeFileSync(path.join(dir, "mission.lua"), serializeLuaAssignment("mission", session.mission));
    if (session.warehouses) writeFileSync(path.join(dir, "warehouses.lua"), serializeLuaAssignment("warehouses", session.warehouses));
    writeFileSync(path.join(dir, "dictionary.lua"), serializeLuaAssignment("dictionary", session.dictionary));
    writeFileSync(path.join(dir, "mapResource.lua"), serializeLuaAssignment("mapResource", session.mapResource));
    for (const name of readdirSync(path.join(dir, 'files'))) {
      assertSafeResourceName(name);
      const previous = path.join(dir, 'files', name);
      if (!session.files.has(name) && statSync(previous).isFile()) rmSync(previous);
    }
    for (const [name, bytes] of session.files) {
      assertSafeResourceName(name);
      const target = path.join(dir, "files", name);
      if (!existsSync(target) || statSync(target).size !== bytes.length || !readFileSync(target).equals(bytes)) writeFileSync(target, bytes);
    }
    const meta: SnapshotMeta = {
      id: session.id,
      sourcePath: session.sourcePath,
      openedAt: session.openedAt,
      updatedAt: new Date().toISOString(),
      dirty: session.dirty,
      theatre: session.document.theatre,
      groupCount: session.document.summary.groupCount,
      baseline: session.baseline,
    };
    if (session.archiveFiles || session.removedEntries) writeFileSync(path.join(dir, "archive-edits.json"), JSON.stringify({
      files: [...(session.archiveFiles ?? [])].map(([name, bytes]) => [name, bytes.toString('base64')]),
      removed: [...(session.removedEntries ?? [])],
    }));
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  } catch (err) {
    console.error(`dcs-mcp: could not snapshot session ${session.id}: ${(err as Error).message}`);
  }
}

export interface SnapshotInfo {
  id: string;
  sourcePath?: string;
  openedAt: string;
  updatedAt: string;
  dirty: boolean;
  theatre: string;
  groupCount: number;
}

/** Snapshots on disk that are not currently open in this process. */
export function listSnapshots(): SnapshotInfo[] {
  if (!stateDir || !existsSync(stateDir)) return [];
  const out: SnapshotInfo[] = [];
  for (const id of readdirSync(stateDir)) {
    if (sessions.has(id)) continue;
    const dir = snapshotDir(id);
    if (!dir) continue;
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as SnapshotMeta;
      const { baseline: _baseline, ...info } = meta;
      out.push(info);
    } catch {
      // Incomplete snapshot (crashed mid-write): skip it.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Reload a snapshotted session under its original id. */
export function restoreSession(id: string): MissionSession {
  const existing = sessions.get(id);
  if (existing) return existing;
  const dir = snapshotDir(id);
  if (!dir || !existsSync(path.join(dir, "meta.json"))) {
    throw new Error(`No snapshot for session '${id}'. dcs_miz_list_sessions shows what can be restored.`);
  }
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as SnapshotMeta;
  const mission = parseLuaAssignment(readFileSync(path.join(dir, "mission.lua"), "utf8"), "mission");
  const dictionary = parseLuaAssignment(readFileSync(path.join(dir, "dictionary.lua"), "utf8"), "dictionary");
  const mapResource = parseLuaAssignment(readFileSync(path.join(dir, "mapResource.lua"), "utf8"), "mapResource");
  const files = new Map<string, Buffer>();
  const filesDir = path.join(dir, "files");
  if (existsSync(filesDir)) {
    for (const name of readdirSync(filesDir)) {
      assertSafeResourceName(name);
      files.set(name, readFileSync(path.join(filesDir, name)));
    }
  }
  const session: MissionSession = {
    id: meta.id,
    sourcePath: meta.sourcePath,
    openedAt: meta.openedAt,
    mission,
    ...(existsSync(path.join(dir, "warehouses.lua")) ? { warehouses: parseLuaAssignment(readFileSync(path.join(dir, "warehouses.lua"), "utf8"), "warehouses") } : {}),
    dictionary,
    mapResource,
    files,
    sourceBytes: readFileSync(path.join(dir, "source.miz")),
    document: buildMissionDocument(mission, dictionary, digestOf(mission)),
    baseline: meta.baseline,
    dirty: meta.dirty,
  };
  const editsPath = path.join(dir, 'archive-edits.json');
  if (existsSync(editsPath)) {
    const edits = JSON.parse(readFileSync(editsPath, 'utf8')) as { files: [string, string][]; removed: string[] };
    for (const [name] of edits.files) assertSafeEntryName(name);
    for (const name of edits.removed) assertSafeEntryName(name);
    session.archiveFiles = new Map(edits.files.map(([name, bytes]) => [name, Buffer.from(bytes, 'base64')]));
    session.removedEntries = new Set(edits.removed);
  }
  sessions.set(session.id, session);
  return session;
}

/** Open an existing `.miz` file as a session. */
export async function openSession(sourcePath: string): Promise<MissionSession> {
  const archive = await readMizArchive(sourcePath);
  const { mission, dictionary, mapResource } = parseMissionTables(archive);
  const session: MissionSession = {
    id: newId(),
    sourcePath,
    openedAt: new Date().toISOString(),
    mission,
    dictionary: dictionary ?? {},
    mapResource: mapResource ?? {},
    files: new Map(),
    sourceBytes: archive.bytes,
    document: buildMissionDocument(mission, dictionary, archive.digest),
    baseline: buildMissionDocument(mission, dictionary, archive.digest),
    dirty: false,
  };
  sessions.set(session.id, session);
  snapshot(session);
  return session;
}

/** Create a new, empty mission session from the built-in template. */
export function newSession(theatre: string, startTime: number): MissionSession {
  const mission = newMissionTable(theatre, startTime);
  const zip = new AdmZip();
  zip.addFile("mission", Buffer.from(serializeLuaAssignment("mission", mission), "utf8"));
  zip.addFile("theatre", Buffer.from(theatre, "utf8"));
  zip.addFile("options", Buffer.from(serializeLuaAssignment("options", {}), "utf8"));
  zip.addFile("warehouses", Buffer.from(serializeLuaAssignment("warehouses", {}), "utf8"));
  zip.addFile(
    "l10n/DEFAULT/dictionary",
    Buffer.from(serializeLuaAssignment("dictionary", {}), "utf8")
  );
  zip.addFile("l10n/DEFAULT/mapResource", Buffer.from(serializeLuaAssignment("mapResource", {}), "utf8"));

  const session: MissionSession = {
    id: newId(),
    openedAt: new Date().toISOString(),
    mission,
    dictionary: {},
    mapResource: {},
    files: new Map(),
    sourceBytes: zip.toBuffer(),
    document: buildMissionDocument(mission, {}, digestOf(mission)),
    baseline: buildMissionDocument(mission, {}, digestOf(mission)),
    dirty: true,
  };
  sessions.set(session.id, session);
  snapshot(session);
  return session;
}

/** Save the (possibly modified) session to a NEW `.miz` file (copy-on-write). */
export async function saveSessionAs(
  session: MissionSession,
  outPath: string,
  overwrite = false
): Promise<{ digest: string; outPath: string }> {
  const replacements = new Map<string, string | Buffer>();
  if (session.warehouses) replacements.set("warehouses", serializeLuaAssignment("warehouses", session.warehouses));
  replacements.set("mission", serializeLuaAssignment("mission", session.mission));
  replacements.set("l10n/DEFAULT/dictionary", serializeLuaAssignment("dictionary", session.dictionary));
  replacements.set("l10n/DEFAULT/mapResource", serializeLuaAssignment("mapResource", session.mapResource));
  // Embedded resources (framework scripts, sounds, pictures) live beside the
  // dictionary; their names were validated when they were added.
  for (const [fileName, bytes] of session.files) {
    assertSafeResourceName(fileName);
    if (!session.removedEntries?.has(`${L10N_PREFIX}${fileName}`)) replacements.set(`${L10N_PREFIX}${fileName}`, bytes);
  }
  replacements.set('theatre', String(session.mission.theatre));
  for (const [name, bytes] of session.archiveFiles ?? []) if (!session.removedEntries?.has(name)) replacements.set(name, bytes);
  const result = await packMiz(
    session.sourceBytes,
    replacements,
    outPath,
    session.sourcePath,
    overwrite,
    session.removedEntries
  );
  session.dirty = false;
  snapshot(session);
  return result;
}

export function requireSession(id: string): MissionSession {
  const session = sessions.get(id);
  if (!session) {
    // The server restarted under the client: bring the snapshot back transparently,
    // so a sessionId the client still holds keeps working.
    const dir = snapshotDir(id);
    if (dir && existsSync(path.join(dir, "meta.json"))) return restoreSession(id);
    throw new Error(
      `No open mission session '${id}'. Call dcs_miz_open or dcs_miz_new first, then reuse the returned sessionId.`
    );
  }
  return session;
}

/** Close a session (open or only snapshotted) and delete its snapshot. */
export function closeSession(id: string): boolean {
  const dir = snapshotDir(id);
  const hadSnapshot = !!dir && existsSync(dir);
  if (dir && hadSnapshot) rmSync(dir, { recursive: true, force: true });
  return sessions.delete(id) || hadSnapshot;
}

export function listSessions(): MissionSession[] {
  return [...sessions.values()];
}

/**
 * Drop a session from memory but keep its snapshot — what a server restart does.
 * Exposed for tests; tools use closeSession.
 */
export function evictSession(id: string): boolean {
  return sessions.delete(id);
}
