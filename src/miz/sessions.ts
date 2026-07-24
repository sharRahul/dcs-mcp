/**
 * In-memory mission sessions.
 *
 * `dcs_miz_open` parses a source `.miz` into a canonical document held under a
 * session id. Other tools reference that document read-only. The source archive
 * on disk is never modified. Sessions live only for the server process lifetime.
 */
import { randomUUID } from "node:crypto";
import { readMizArchive } from "./archive.js";
import { parseMission } from "./parser.js";
import type { MissionDocument } from "../types.js";

export interface MissionSession {
  id: string;
  sourcePath: string;
  openedAt: string;
  document: MissionDocument;
}

const sessions = new Map<string, MissionSession>();

/** Open a `.miz` file as a read-only session and return it. */
export async function openSession(sourcePath: string): Promise<MissionSession> {
  const archive = await readMizArchive(sourcePath);
  const document = parseMission(archive);
  const session: MissionSession = {
    id: `miz-${randomUUID().slice(0, 8)}`,
    sourcePath,
    openedAt: new Date().toISOString(),
    document,
  };
  sessions.set(session.id, session);
  return session;
}

/** Look up an open session, or throw an actionable error. */
export function requireSession(id: string): MissionSession {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(
      `No open mission session '${id}'. Call dcs_miz_open first, then reuse the returned sessionId.`
    );
  }
  return session;
}

/** Close a session and free its document. Returns true if a session was removed. */
export function closeSession(id: string): boolean {
  return sessions.delete(id);
}

export function listSessions(): MissionSession[] {
  return [...sessions.values()];
}
