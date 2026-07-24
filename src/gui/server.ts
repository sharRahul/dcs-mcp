#!/usr/bin/env node
/**
 * Minimalist local web GUI for DCS-MCP.
 *
 * Serves a single page that drives the SAME core logic as the MCP tools. Offline
 * authoring is always available. Live control (spawn/message/units/raw Lua) is
 * gated behind an in-app "online" toggle, which the user must switch on explicitly.
 *
 * Binds to 127.0.0.1 only. Run with: npm run gui  (GUI_PORT overrides the port).
 */
import express, { type Request, type Response } from "express";
import { PAGE_HTML } from "./page.js";
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from "../constants.js";
import { bridgeRequest, type BridgeRequest } from "../bridge/client.js";
import {
  closeSession,
  newSession,
  openSession,
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

/** Server-side gate: live actions are refused until the user toggles online mode. */
let online = false;

const bridgeOpts = {
  host: process.env.DCS_BRIDGE_HOST ?? BRIDGE_DEFAULT_HOST,
  port: Number(process.env.DCS_BRIDGE_PORT ?? BRIDGE_DEFAULT_PORT),
};

const app = express();
app.use(express.json({ limit: "1mb" }));

/** Wrap a handler so thrown errors become clean 400 JSON. */
function handler(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** Refuse live endpoints unless online mode is on. */
function requireOnline(res: Response): boolean {
  if (!online) {
    res.status(403).json({ error: "Online mode is off. Toggle it on to use live control." });
    return false;
  }
  return true;
}

app.get("/", (_req, res) => res.type("html").send(PAGE_HTML));
app.get("/api/state", (_req, res) => res.json({ online, bridge: bridgeOpts }));

app.post(
  "/api/online",
  handler((req, res) => {
    online = Boolean(req.body?.enabled);
    res.json({ online });
  })
);

// ---- Session lifecycle ----------------------------------------------------
app.post(
  "/api/miz/new",
  handler((req, res) => {
    const s = newSession(String(req.body?.theatre ?? "Caucasus"), Number(req.body?.startTime ?? 43200));
    res.json({ sessionId: s.id, theatre: s.document.theatre });
  })
);

app.post(
  "/api/miz/open",
  handler(async (req, res) => {
    const s = await openSession(String(req.body?.path ?? ""));
    res.json({ sessionId: s.id, theatre: s.document.theatre, groupCount: s.document.summary.groupCount });
  })
);

app.get(
  "/api/miz/:id/summary",
  handler((req, res) => res.json(requireSession(req.params.id).document.summary))
);

app.get(
  "/api/miz/:id/diff",
  handler((req, res) => {
    const s = requireSession(req.params.id);
    const b = new Set(s.baseline.groups.map((g) => g.name));
    const c = new Set(s.document.groups.map((g) => g.name));
    res.json({
      groupsAdded: [...c].filter((n) => !b.has(n)),
      groupsRemoved: [...b].filter((n) => !c.has(n)),
      dirty: s.dirty,
    });
  })
);

// ---- Authoring mutations (always available) -------------------------------
/** Run a mutation on a session, then refresh + mark dirty and reply with a message. */
function mutate(req: Request, res: Response, fn: (m: ReturnType<typeof requireSession>) => unknown): void {
  const s = requireSession(req.params.id);
  const result = fn(s);
  s.dirty = true;
  refresh(s);
  res.json({ ok: true, result, summary: s.document.summary });
}

app.post(
  "/api/miz/:id/add-aircraft",
  handler((req, res) =>
    mutate(req, res, (s) => addAircraftGroup(s.mission, req.body.category ?? "plane", req.body).name)
  )
);
app.post(
  "/api/miz/:id/add-ground",
  handler((req, res) =>
    mutate(req, res, (s) => addGroundGroup(s.mission, req.body.category ?? "vehicle", req.body).name)
  )
);
app.post(
  "/api/miz/:id/add-waypoint",
  handler((req, res) => mutate(req, res, (s) => addWaypoint(s.mission, req.body.group, req.body)))
);
app.post(
  "/api/miz/:id/add-zone",
  handler((req, res) => mutate(req, res, (s) => addTriggerZone(s.mission, req.body).name))
);
app.post(
  "/api/miz/:id/add-trigger",
  handler((req, res) =>
    mutate(req, res, (s) =>
      addTrigger(s.mission, {
        type: req.body.type ?? "once",
        comment: req.body.comment,
        conditions: (req.body.conditions ?? []) as ConditionSpec[],
        actions: (req.body.actions ?? []) as ActionSpec[],
      })
    )
  )
);
app.post(
  "/api/miz/:id/set-payload",
  handler((req, res) => mutate(req, res, (s) => setPayload(s.mission, req.body.unit, req.body)))
);
app.post(
  "/api/miz/:id/set-task",
  handler((req, res) => mutate(req, res, (s) => setGroupTask(s.mission, req.body.group, req.body.task)))
);
app.post(
  "/api/miz/:id/set-weather",
  handler((req, res) => mutate(req, res, (s) => setWeather(s.mission, req.body)))
);
app.post(
  "/api/miz/:id/set-briefing",
  handler((req, res) => mutate(req, res, (s) => setBriefing(s.mission, req.body.title, req.body.description)))
);

app.post(
  "/api/miz/:id/save",
  handler(async (req, res) => {
    const s = requireSession(req.params.id);
    const report = validateMission(s.document);
    if (!report.ok && !req.body.force) {
      res.json({ saved: false, validation: report });
      return;
    }
    const { digest, outPath } = await saveSessionAs(s, String(req.body.outPath ?? ""));
    res.json({ saved: true, outPath, digest, validation: report });
  })
);

app.post(
  "/api/miz/:id/close",
  handler((req, res) => res.json({ closed: closeSession(req.params.id) }))
);

// ---- Live control (gated on online mode) ----------------------------------
function liveEndpoint(cmd: string, mapArgs: (body: any) => Record<string, unknown>) {
  return handler(async (req: Request, res: Response) => {
    if (!requireOnline(res)) return;
    const request: BridgeRequest = { cmd, args: mapArgs(req.body ?? {}) };
    res.json({ data: await bridgeRequest(request, bridgeOpts) });
  });
}

app.post("/api/live/status", handler(async (_req, res) => {
  if (!requireOnline(res)) return;
  res.json({ data: await bridgeRequest({ cmd: "ping" }, bridgeOpts) });
}));
app.post("/api/live/units", liveEndpoint("units", (b) => ({ coalition: b.coalition ?? "all" })));
app.post("/api/live/message", liveEndpoint("message", (b) => ({ text: b.text, seconds: b.seconds ?? 20 })));
app.post(
  "/api/live/spawn",
  liveEndpoint("spawn", (b) => ({
    name: b.name,
    type: b.type,
    lat: b.lat,
    lon: b.lon,
    heading: b.heading ?? 0,
    country: b.country ?? 2,
  }))
);
app.post(
  "/api/live/exec",
  handler(async (req, res) => {
    if (!requireOnline(res)) return; // toggle unlocks live actions AND raw Lua per user's choice
    res.json({ data: await bridgeRequest({ cmd: "exec", args: { code: req.body.code, env: req.body.env ?? "mission" } }, bridgeOpts) });
  })
);

const port = Number(process.env.GUI_PORT ?? 4700);
app.listen(port, "127.0.0.1", () => {
  console.error(`DCS-MCP GUI on http://127.0.0.1:${port}  (online mode starts OFF)`);
});
