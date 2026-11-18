/** Structured aircraft diagnostics/control; no model-supplied Lua or arbitrary tasks. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bridgeRequest } from '../bridge/client.js';
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from '../constants.js';
import { buildResult, errorResult } from './format.js';

const name = z.string().min(1).max(200);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const zone = z.object({ ...point.shape, radiusMetres: z.number().positive().max(500000) }).strict();
const flag = z.string().min(1).max(64);
const connection = {
  host: z.string().min(1).default(process.env.DCS_BRIDGE_HOST?.trim() || BRIDGE_DEFAULT_HOST),
  port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT),
};
const orbit = z.object({ kind: z.literal('orbit'), point, point2: point.optional(),
  pattern: z.enum(['Circle', 'Race-Track']).default('Circle'), altitudeMetres: z.number().positive().max(20000), speedMps: z.number().positive().max(400),
}).strict().refine(t => t.pattern !== 'Race-Track' || t.point2 && (t.point.x !== t.point2.x || t.point.y !== t.point2.y), 'Race-Track requires distinct point2');
const routePoint = z.object({ ...point.shape, altitudeMetres: z.number().nonnegative().max(20000), speedMps: z.number().positive().max(400),
  kind: z.enum(['turning', 'landing']).default('turning'), airdromeId: z.number().int().positive().optional(),
}).strict();
const task = z.union([orbit, z.object({ kind: z.literal('awacs') }).strict(), z.object({ kind: z.literal('tanker') }).strict(),
  z.object({ kind: z.literal('route'), points: z.array(routePoint).min(2).max(50) }).strict()
    .refine(t => t.points.every((p, i) => p.kind !== 'landing' || i === t.points.length - 1 && p.airdromeId !== undefined), 'Landing requires final waypoint and airdromeId'),
]);
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const outputSchema = z.object({ aircraft: z.unknown() });
type Connection = { host: string; port: number };
async function call({ host, port, ...args }: Connection & Record<string, unknown>) {
  try {
    const aircraft = await bridgeRequest({ cmd: 'aircraft_ai', args }, { host, port });
    return buildResult(JSON.stringify(aircraft, null, 2), { aircraft });
  } catch (err) { return errorResult(err); }
}

export function registerAircraftRuntimeTools(server: McpServer) {
  server.registerTool('dcs_aircraft_detect', {
    title: 'Inspect aircraft contacts and history',
    description: 'Query group-controller detections using selected DCS detection methods. Empty methods means any method, not independent per-sensor attribution. Keeps bounded mission-local history per group/method selection (100 observers, 1000 contacts each; max 200 queried contacts per request). Missing fields remain unknown. Never reads target world position/velocity/coalition/name. Contact IDs are diagnostic correlation handles. This exposes DCS controller knowledge, not individual crew perception. Requires updated hook. clearHistory only clears this query selection.',
    inputSchema: z.object({ group: name, methods: z.array(z.enum(['VISUAL', 'OPTIC', 'RADAR', 'IRST', 'RWR', 'DLINK'])).max(6).default([]),
      maxAgeSeconds: z.number().min(1).max(3600).default(300), clearHistory: z.boolean().default(false), ...connection }).strict(),
    outputSchema, annotations: read,
  }, args => call({ ...args, operation: 'detect' }));

  server.registerTool('dcs_aircraft_inspect_options', {
    title: 'Inspect authored aircraft options and bridge writes',
    description: 'Read main-task metadata, authored waypoint options, recorded bridge option writes and hasTask. DCS has no documented current-option/full-task-queue getter: authored options may not have executed and other scripts can override bridge writes. Does not claim these are current engine settings.',
    inputSchema: z.object({ group: name, ...connection }).strict(), outputSchema, annotations: read,
  }, args => call({ ...args, operation: 'options' }));

  server.registerTool('dcs_aircraft_set_option', {
    title: 'Set a supported live aircraft option',
    description: 'Set native DCS ROE (0–4), threat reaction (0–5), radar use (0–3) or supported fixed-wing formation and record the request for inspection. Acceptance does not prove flight behavior; aircraft capabilities and other scripts still apply. Reaction 5 is Horizontal AAA Fire Evade. No automatic role/country presets.',
    inputSchema: z.object({ group: name, option: z.enum(['roe', 'reaction', 'radar', 'formation']), value: z.number().int().nonnegative(), ...connection }).strict()
      .refine(a => a.option === 'formation' ? [131073, 196609, 262145, 327681, 393217, 458753].includes(a.value) : a.value <= (a.option === 'reaction' ? 5 : a.option === 'radar' ? 3 : 4), 'Unsupported option value'),
    outputSchema, annotations: write,
  }, args => call({ ...args, operation: 'set_option' }));

  server.registerTool('dcs_aircraft_task', {
    title: 'Control native aircraft task lifecycle',
    description: 'Validated controller set/push/pop/reset/inspect, plus suspend/resume using a caller-specified temporary Orbit. set/reset clear native queued tasking. suspend pushes a ControlledTask with a private stop flag; resume releases it without popping unrelated tasks. No setOnOff for aircraft, no task-queue snapshot/restore, and no arbitrary scripts/tasks. Supported tasks: Orbit, AWACS/Tanker matching authored main task, or 2–50 point Mission route (BARO metres, m/s, optional final airfield landing). Route geometry, safe altitudes, aircraft performance and service execution need DCS verification. Mutations report requested, not observed execution.',
    inputSchema: z.object({ group: name, action: z.enum(['inspect', 'set', 'push', 'pop', 'reset', 'suspend', 'resume']), task: task.optional(), ...connection }).strict()
      .refine(a => ['set', 'push', 'suspend'].includes(a.action) ? a.task !== undefined && (a.action !== 'suspend' || a.task.kind === 'orbit') : a.task === undefined, 'set/push require task; suspend requires Orbit; other actions accept no task'),
    outputSchema, annotations: write,
  }, args => call({ ...args, operation: 'task' }));

  server.registerTool('dcs_support_flight_register', {
    title: 'Register support-flight and transport monitoring',
    description: 'Explicitly begin bounded mission-local monitoring (max 50 flights). Installs a landing/takeoff/loss event listener once; does not change tasks. Supply station/recovery areas and optional mission flags (true means value 1). Transport pickup/drop areas identify arrival; optional troops track initially registered survivors at destination. loadedFlag/unloadedFlag are scenario assertions, not independent cargo proof. Re-registering resets this monitor. Events before registration are unavailable. AWACS/tanker role must match authored main task.',
    inputSchema: z.object({ name, group: name, role: z.enum(['AWACS', 'tanker', 'transport', 'reconnaissance']), station: zone.optional(), recovery: zone.optional(),
      returningFlag: flag.optional(), failureFlag: flag.optional(), pickup: zone.optional(), drop: zone.optional(), troops: name.optional(), loadedFlag: flag.optional(), unloadedFlag: flag.optional(), ...connection }).strict()
      .refine(a => a.role === 'transport' ? a.pickup !== undefined && a.drop !== undefined : !a.pickup && !a.drop && !a.troops && !a.loadedFlag && !a.unloadedFlag, 'Transport requires pickup/drop; cargo fields apply only to transport'),
    outputSchema, annotations: write,
  }, args => call({ ...args, operation: 'monitor_register' }));

  for (const [toolName, operation, description] of [
    ['dcs_support_flight_inspect', 'monitor_inspect', 'Read registered support-flight state: planned/active/on_station/returning/landed/failed/unknown with evidence and per-unit observer telemetry. Station geometry does not prove AWACS/tanker service. Returning requires configured mission flag. Landing requires a post-registration event and surviving aircraft on ground in the recovery area. No service availability is inferred.'],
    ['dcs_transport_verify', 'transport', 'Inspect a registered transport: pickup/drop arrival, scenario-reported loading, live troops observed at destination, and landing-confirmed recovery. DCS exposes no documented passenger manifest getter. Missing troops never prove loading; destination presence does not establish which aircraft carried them. Ground/troop snapshots are observer data, not pilot knowledge.'],
  ] as const) {
    server.registerTool(toolName, { title: operation === 'transport' ? 'Verify transport evidence' : 'Inspect support-flight lifecycle', description,
      inputSchema: z.object({ name, ...connection }).strict(), outputSchema, annotations: read,
    }, args => call({ ...args, operation }));
  }
  server.registerTool('dcs_support_flight_remove', {
    title: 'Remove support-flight monitoring', description: 'Remove a named mission-local monitor and free its slot. Does not change flight tasking. Shared event history remains bounded to 500 events until mission reset.',
    inputSchema: z.object({ name, ...connection }).strict(), outputSchema, annotations: write,
  }, args => call({ ...args, operation: 'monitor_remove' }));
}
