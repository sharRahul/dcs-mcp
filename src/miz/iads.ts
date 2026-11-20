/** Builds setup after the existing ordered framework load trigger. Never executes mission Lua here. */
import { z } from 'zod';
import { eachGroup, appendTriggerActions } from './authoring.js';
import { loadScripts, resolveFrameworkPath } from './frameworks.js';
import { quoteLuaString } from './serializer.js';
import { luaArray } from './lua.js';
import type { MissionSession } from './sessions.js';
export const iadsSchema = z.object({
  name: z.string().min(1).max(64), side: z.enum(['red', 'blue']), samPrefix: z.string().min(1).max(64).default('SAM'),
  ewrPrefix: z.string().min(1).max(64).default('EW'), goLivePercent: z.number().int().min(1).max(100).default(80),
  harmDetectionPercent: z.number().int().min(0).max(100).default(50), radioMenu: z.boolean().default(false),
  mistPath: z.string().min(1).optional(), skynetPath: z.string().min(1).optional(),
}).strict();
export async function configureIads(session: MissionSession, input: z.input<typeof iadsSchema>) {
  const spec = iadsSchema.parse(input);
  const original = JSON.stringify([session.mission, session.dictionary, session.mapResource]);
  const sams: string[] = [], ewrs: string[] = [];
  eachGroup(session.mission, (group, category, side) => {
    if (category !== 'vehicle') return;
    const sam = String(group.name).startsWith(spec.samPrefix);
    const matchedEwrs = luaArray(group.units).filter(u => String(u.name).startsWith(spec.ewrPrefix));
    if ((sam || matchedEwrs.length) && side !== spec.side) throw new Error('IADS prefixes also match another coalition; use unique prefixes');
    if (sam) sams.push(String(group.name));
    ewrs.push(...matchedEwrs.map(u => String(u.name)));
  });
  if (!sams.length) throw new Error('No SAM groups match samPrefix');
  const marker = `DCS Sortie MCP IADS ${spec.name}`;
  if (luaArray(session.mission.trigrules).some(rule => luaArray(rule.actions).some(action => String(action.text ?? '').includes(marker))))
    throw new Error(`IADS '${spec.name}' is already configured`);
  // Work on copies; missing files or load errors leave the session untouched.
  const mission = structuredClone(session.mission), dictionary = structuredClone(session.dictionary),
    mapResource = structuredClone(session.mapResource), files = new Map(session.files);
  const scripts = [
    { framework: 'mist' as const, filePath: await resolveFrameworkPath('mist', spec.mistPath) },
    { framework: 'skynet' as const, filePath: await resolveFrameworkPath('skynet', spec.skynetPath) },
  ];
  const loaded = await loadScripts({ mission, mapResource, files }, dictionary, scripts);
  const lua = `-- ${marker.replace(/[\r\n]/g, ' ')}\n` +
    `local iads = SkynetIADS:create(${quoteLuaString(spec.name)})\n` +
    `iads:addEarlyWarningRadarsByPrefix(${quoteLuaString(spec.ewrPrefix)})\n` +
    `iads:addSAMSitesByPrefix(${quoteLuaString(spec.samPrefix)})\n` +
    `for _, site in ipairs(iads:getSAMSites()) do\n` +
    `  site:setGoLiveRangeInPercent(${spec.goLivePercent})\n` +
    `  site:setHARMDetectionChance(${spec.harmDetectionPercent})\nend\n` +
    (spec.radioMenu ? 'iads:addRadioMenu()\n' : '') +
    `iads:activate()\n` +
    `DCSMCP_IADS = DCSMCP_IADS or {}\nDCSMCP_IADS[${quoteLuaString(spec.name)}] = iads\n` +
    `env.info('[DCSMCP] IADS configured samSites=' .. tostring(#iads:getSAMSites()) .. ' ewRadars=' .. tostring(#iads:getEarlyWarningRadars()))`;
  appendTriggerActions(mission, loaded.triggerIndex, [{ kind: 'do_script', text: lua }], dictionary);
  if (JSON.stringify([session.mission, session.dictionary, session.mapResource]) !== original) throw new Error("Mission changed during framework loading; retry IADS configuration");
  Object.assign(session, { mission, dictionary, mapResource, files });
  return { name: spec.name, sams, ewrs, triggerIndex: loaded.triggerIndex,
    warnings: ['Prefix membership does not verify battery composition or engagement; inspect live IADS telemetry', 'Offline only; generated setup not run in DCS'] };
}
