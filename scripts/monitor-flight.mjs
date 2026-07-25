/**
 * Live flight monitor.
 *
 * Two independent signals, because each one goes blind exactly where the other
 * still works:
 *
 *   - `dcs.log`, tailed incrementally. Carries the mission-side telemetry
 *     ([DCSMCP] lines from scripts/dcs-mcp-telemetry.lua) and every Lua error
 *     DCS raises. Works during load, when the mission environment does not exist
 *     yet and the bridge cannot answer for it.
 *   - the TCP bridge, polled. Says whether DCS is alive and what phase it is in,
 *     which is how a mission that silently failed to start is told apart from a
 *     mission that is running quietly.
 *
 * Writes two files:
 *   events.jsonl  append-only, everything seen, newest last
 *   digest.json   rewritten each poll: counters, latest state, all trigger
 *                 firings, all errors — small enough to read repeatedly
 *
 *   node scripts/monitor-flight.mjs [outDir] [intervalSeconds]
 */
import { open, stat, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { parseLog, findProblems, defaultLogPath } from "../dist/dcs/log.js";

const OUT_DIR = process.argv[2] ?? path.join(process.cwd(), ".monitor");
const INTERVAL_MS = Number(process.argv[3] ?? 5) * 1000;
const LOG_PATH = defaultLogPath();
const EVENTS = path.join(OUT_DIR, "events.jsonl");
const DIGEST = path.join(OUT_DIR, "digest.json");

await mkdir(OUT_DIR, { recursive: true });

// --------------------------------------------------------------------------
// Bridge
// --------------------------------------------------------------------------
function bridge(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = "";
    const done = (value) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        done(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        done({ ok: false, error: `malformed: ${e.message}` });
      }
    });
    sock.on("error", (e) => done({ ok: false, error: e.message }));
    sock.on("close", () => done({ ok: false, error: "closed without reply" }));
    sock.connect(8899, "127.0.0.1", () => sock.write(JSON.stringify({ cmd, args }) + "\n"));
  });
}

// --------------------------------------------------------------------------
// Incremental log tail
// --------------------------------------------------------------------------
let offset = 0;
let carry = "";

/** Read only what was appended since the last poll. */
async function tail() {
  const info = await stat(LOG_PATH).catch(() => undefined);
  if (!info) return "";
  // A shrunken file means DCS rotated the log; start over rather than seeking
  // past the end and reading nothing for the rest of the session.
  if (info.size < offset) {
    offset = 0;
    carry = "";
  }
  if (info.size === offset) return "";
  const fh = await open(LOG_PATH, "r");
  try {
    const length = info.size - offset;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, offset);
    offset = info.size;
    const text = carry + buf.toString("utf8");
    // Hold back a trailing partial line so a log entry split across two polls is
    // not parsed as two broken ones.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) {
      carry = text;
      return "";
    }
    carry = text.slice(lastNl + 1);
    return text.slice(0, lastNl + 1);
  } finally {
    await fh.close();
  }
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
const state = {
  startedAt: new Date().toISOString(),
  polls: 0,
  bridge: { lastOk: null, lastError: null, drops: 0, phase: null, phaseHistory: [] },
  counts: {},
  frameworks: {},
  terrain: { checked: 0, onWater: [] },
  triggers: [],
  iads: [],
  iadsSites: {},
  events: [],
  states: [],
  errors: [],
  proofs: [],
};

const bump = (k) => {
  state.counts[k] = (state.counts[k] ?? 0) + 1;
};

/** `key=value key=value` -> object. The telemetry format has no quoted spaces. */
function kv(rest) {
  const out = {};
  for (const m of rest.matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

const append = (record) => appendFile(EVENTS, JSON.stringify(record) + "\n", "utf8");

async function handleTelemetry(entry) {
  const m = /\[DCSMCP\]\s+(\w+)\s*(.*)$/.exec(entry.message);
  if (!m) return false;
  const [, kind, rest] = m;
  const fields = kv(rest);
  bump(kind);
  await append({ at: entry.timestamp, src: "telemetry", kind, ...fields });

  switch (kind) {
    case "FRAMEWORK":
      state.frameworks[fields.name] = { loaded: fields.loaded === "1", version: fields.version };
      break;
    case "PROOF":
      state.proofs.push({ at: entry.timestamp, ...fields });
      break;
    case "TERRAIN":
      state.terrain.checked++;
      break;
    case "TERRAIN_WATER":
      state.terrain.onWater.push({ at: entry.timestamp, ...fields });
      break;
    case "TERRAIN_SUMMARY":
      state.terrain.summary = fields;
      break;
    case "TRIG":
      state.triggers.push({ at: entry.timestamp, ...fields });
      break;
    case "IADS":
      state.iads.push({ at: entry.timestamp, ...fields });
      if (state.iads.length > 200) state.iads.shift();
      break;
    case "IADS_SITE":
      state.iadsSites[fields.site] = { at: entry.timestamp, ...fields };
      break;
    case "EVT":
      state.events.push({ at: entry.timestamp, ...fields });
      if (state.events.length > 500) state.events.shift();
      break;
    case "STATE":
      state.states.push({ at: entry.timestamp, ...fields });
      if (state.states.length > 500) state.states.shift();
      break;
    default:
      break;
  }
  return true;
}

async function poll() {
  state.polls++;

  const chunk = await tail();
  if (chunk) {
    const entries = parseLog(chunk);
    for (const entry of entries) {
      if (await handleTelemetry(entry)) continue;
    }
    // Anything DCS itself flagged. Telemetry lines are excluded: the [DCSMCP]
    // ERROR lines are already captured above with their fields parsed.
    for (const p of findProblems(entries)) {
      if (p.message.includes("[DCSMCP]")) continue;
      bump("DCS_PROBLEM");
      const rec = {
        at: p.timestamp,
        src: "dcs",
        level: p.level,
        source: p.source,
        message: p.message,
        detail: p.detail,
        blames: p.blames,
      };
      state.errors.push(rec);
      if (state.errors.length > 200) state.errors.shift();
      await append(rec);
    }
  }

  const status = await bridge("status");
  const now = new Date().toISOString();
  if (status?.ok) {
    state.bridge.lastOk = now;
    state.bridge.lastError = null;
    const phase = status.data?.phase;
    if (phase !== state.bridge.phase) {
      state.bridge.phaseHistory.push({ at: now, from: state.bridge.phase, to: phase, mission: status.data?.mission });
      state.bridge.phase = phase;
      await append({ at: now, src: "bridge", kind: "PHASE", phase, mission: status.data?.mission });
    }
    state.bridge.status = status.data;
  } else {
    state.bridge.drops++;
    state.bridge.lastError = { at: now, error: status?.error ?? "unknown" };
    bump("BRIDGE_DROP");
    await append({ at: now, src: "bridge", kind: "DROP", error: status?.error });
  }

  state.updatedAt = now;
  await writeFile(DIGEST, JSON.stringify(state, null, 1), "utf8");
}

// Start at the end of the log: this run cares about what happens from now on,
// not about the megabytes of startup chatter already on disk.
const initial = await stat(LOG_PATH).catch(() => undefined);
offset = initial?.size ?? 0;

console.log(`monitoring ${LOG_PATH}`);
console.log(`from offset ${offset}, every ${INTERVAL_MS / 1000}s`);
console.log(`digest -> ${DIGEST}`);

await poll();
setInterval(() => {
  poll().catch((e) => console.error("poll failed:", e.message));
}, INTERVAL_MS);
