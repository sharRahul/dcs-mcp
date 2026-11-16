/**
 * Edit one unit. Same rules as the flight/group tools: headings are degrees in, radians in the
 * file; one Player per mission; Client/Player, livery, tail number and altitude apply to
 * aircraft only; liveries are checked against installed folders. Offline only.
 */
import { z } from 'zod';
import { luaArray, type LuaTable } from './lua.js';
import { eachGroup, findGroupOfUnit, findUnit } from './authoring.js';
import { findCountryById } from '../data/reference.js';
import { liveryStatus } from '../dcs/liveries.js';

export const unitChangeSchema = z.object({
  skill: z.enum(['Average', 'Good', 'High', 'Excellent', 'Random', 'Player', 'Client']).optional(),
  livery: z.string().min(1).max(200).optional(),
  tailNumber: z.string().regex(/^\d{1,3}$/).optional(),
  headingDegrees: z.number().finite().optional(),
  altitudeMetres: z.number().finite().min(-500).max(30000).optional(),
  playerCanDrive: z.boolean().optional(),
}).strict();

export function modifyUnit(mission: LuaTable, unitName: string, input: z.input<typeof unitChangeSchema>) {
  const change = unitChangeSchema.parse(input);
  const unit = findUnit(mission, unitName);
  const found = findGroupOfUnit(mission, unitName);
  if (!unit || !found) throw new Error(`No unit named '${unitName}' in this mission`);
  const air = found.category === 'plane' || found.category === 'helicopter';
  const warnings: string[] = [];
  const airOnly = (field: string) => { if (!air) throw new Error(`${field} applies to aircraft units only; '${unitName}' is in a ${found.category} group`); };
  if (change.skill === 'Player' || change.skill === 'Client') airOnly(`skill ${change.skill}`);
  if (change.skill === 'Player') {
    let players = 0;
    eachGroup(mission, g => { players += luaArray(g.units).filter(u => u !== unit && u.skill === 'Player').length; });
    if (players) throw new Error('Mission already has a Player unit; use Client for multiplayer slots');
  }
  if (change.livery !== undefined) airOnly('livery');
  if (change.tailNumber !== undefined) airOnly('tailNumber');
  if (change.altitudeMetres !== undefined) airOnly('altitudeMetres');
  if (change.playerCanDrive !== undefined && found.category !== 'vehicle') throw new Error('playerCanDrive applies to ground vehicles only');
  if (change.livery !== undefined) {
    const check = liveryStatus(String(unit.type), change.livery, findCountryById(Number(found.country.id))?.name);
    if (check.status !== 'installed' || check.reason) warnings.push(`livery ${check.status}${check.reason ? `: ${check.reason}` : ''}`);
  }
  if (change.headingDegrees !== undefined && luaArray((found.group.route as LuaTable | undefined)?.points).length >= 2)
    warnings.push('The Mission Editor re-derives unit headings from the first route leg when a group has 2+ waypoints.');
  const changed: string[] = [];
  if (change.skill !== undefined) { unit.skill = change.skill; changed.push('skill'); }
  if (change.livery !== undefined) { unit.livery_id = change.livery; changed.push('livery_id'); }
  if (change.tailNumber !== undefined) { unit.onboard_num = change.tailNumber; changed.push('onboard_num'); }
  if (change.headingDegrees !== undefined) {
    const r = ((change.headingDegrees % 360) + 360) % 360 * Math.PI / 180;
    unit.heading = r; changed.push('heading');
  }
  if (change.altitudeMetres !== undefined) { unit.alt = change.altitudeMetres; unit.alt_type ??= 'BARO'; changed.push('alt'); }
  if (change.playerCanDrive !== undefined) { unit.playerCanDrive = change.playerCanDrive; changed.push('playerCanDrive'); }
  return { unit: unitName, group: found.group.name, changed, warnings };
}
