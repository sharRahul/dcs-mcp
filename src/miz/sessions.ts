/**
 * In-memory mission sessions.
 *
 * A session holds the raw parsed `mission` table (mutated in place by authoring
 * tools, preserving unsupported fields), the original archive bytes (so save is
 * copy-on-write and lossless), and a derived canonical document for reads.
 * The source `.miz` on disk is never modified. Sessions live for the process only.
 */
import { createHash, randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { packMiz, readMizArchive } from "./archive.js";
import { buildMissionDocument, parseMissionTables } from "./parser.js";
import { serializeLuaAssignment } from "./serializer.js";
import { newMissionTable } from "./authoring.js";
import { assertSafeResourceName } from "./resources.js";
import { L10N_PREFIX } from "../constants.js";
import type { LuaTable } from "./lua.js";
import type { MissionDocument } from "../types.js";

export interface MissionSession {
  id: string;
  sourcePath?: string;
  openedAt: string;
  mission: LuaTable;
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

/** Recompute the derived document after a mutation. */
export function refresh(session: MissionSession): void {
  session.document = buildMissionDocument(session.mission, session.dictionary, digestOf(session.mission));
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
  return session;
}

/** Save the (possibly modified) session to a NEW `.miz` file (copy-on-write). */
export async function saveSessionAs(
  session: MissionSession,
  outPath: string,
  overwrite = false
): Promise<{ digest: string; outPath: string }> {
  const replacements = new Map<string, string | Buffer>();
  replacements.set("mission", serializeLuaAssignment("mission", session.mission));
  replacements.set("l10n/DEFAULT/dictionary", serializeLuaAssignment("dictionary", session.dictionary));
  replacements.set("l10n/DEFAULT/mapResource", serializeLuaAssignment("mapResource", session.mapResource));
  // Embedded resources (framework scripts, sounds, pictures) live beside the
  // dictionary; their names were validated when they were added.
  for (const [fileName, bytes] of session.files) {
    assertSafeResourceName(fileName);
    replacements.set(`${L10N_PREFIX}${fileName}`, bytes);
  }
  const result = await packMiz(
    session.sourceBytes,
    replacements,
    outPath,
    session.sourcePath,
    overwrite
  );
  session.dirty = false;
  return result;
}

export function requireSession(id: string): MissionSession {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(
      `No open mission session '${id}'. Call dcs_miz_open or dcs_miz_new first, then reuse the returned sessionId.`
    );
  }
  return session;
}

export function closeSession(id: string): boolean {
  return sessions.delete(id);
}

export function listSessions(): MissionSession[] {
  return [...sessions.values()];
}
