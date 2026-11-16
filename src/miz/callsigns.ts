/**
 * NATO-style callsign families. Numbers come from the Hoggit wiki callsign enums
 * (DCS command setCallsign / DCS enum callsigns, data/hoggit.json):
 *   1-8 generic aircraft names, 1-5 AWACS, 1-3 tanker, 9+ type-specific lists.
 * A type-specific list is offered for a DCS type ONLY when pydcs's `callnames` for that type
 * (data/authoring.json) is literally the same list in the same order — that is the evidence
 * the wiki's numbering belongs to that type. Where they differ (pydcs F-15E has "Mad",
 * pydcs AH-64D has "Chaos"/"Carnivore") the type-specific numbers are refused and the
 * conflict reported; nothing is renumbered from a guess.
 * Unit callsign tables follow the existing writer: {1=family, 2=flight, 3=unit, name="<Name><flight><unit>"}.
 */
import { authoringData } from '../data/authoring.js';
import { hoggitData } from './actions.js';

const TYPE_SPECIFIC = ['a10', 'ah64', 'f16', 'f18', 'f15e', 'b1b', 'b52', 'transport'];
type Role = 'awacs' | 'tanker' | 'aircraft';

function names(template: string): Record<number, string> {
  return Object.fromEntries(Object.entries(hoggitData().callsigns[template]?.names ?? {}).map(([n, s]) => [Number(n), s]));
}

/** Which hoggit type-specific list (if any) matches this DCS type's pydcs callnames exactly. */
export function typeSpecific(type: string): { template?: string; names?: Record<number, string>; conflict?: string } {
  const callnames = (authoringData().aircraft[type] as { callnames?: Record<string, string[]> } | undefined)?.callnames;
  if (!callnames) return {};
  const lists = Object.values(callnames);
  for (const t of TYPE_SPECIFIC) {
    const hog = Object.entries(names(t)).sort(([a], [b]) => Number(a) - Number(b)).map(([, s]) => s);
    if (lists.some(l => l.length === hog.length && l.every((s, i) => s === hog[i]))) return { template: t, names: names(t) };
  }
  const overlap = TYPE_SPECIFIC.find(t => Object.values(names(t)).some(s => lists.some(l => l.includes(s))));
  return { conflict: overlap
    ? `pydcs lists ${type} callsigns [${lists[0].join(', ')}] but the wiki's ${hoggitData().callsigns[overlap].label} list differs; type-specific numbers are not offered`
    : `pydcs lists ${type}-specific callsigns [${lists[0].join(', ')}] with no numbered list on the wiki; not offered` };
}

export function roleFor(task?: string): Role { return task === 'AWACS' ? 'awacs' : task === 'Refueling' ? 'tanker' : 'aircraft'; }

export function callsignOptions(type: string, task?: string) {
  const role = roleFor(task);
  const families: Record<number, string> = { ...names(role) };
  const special = role === 'aircraft' ? typeSpecific(type) : {};
  if (special.names) Object.assign(families, special.names);
  return { type, role, families, typeSpecificList: special.template ? hoggitData().callsigns[special.template].label : null,
    notes: [...(special.conflict ? [special.conflict] : []),
      'Russian-style 3-digit numeric callsigns are also valid (pass a number instead of a family).',
      'Source: Hoggit wiki callsign enums cross-checked with pydcs callnames; not ME-verified.'] };
}

/** Resolve a family given as number or name; flight is the "5" in "Uzi 5-1" (1-9). */
export function resolveFamily(type: string, task: string | undefined, family: number | string): { family: number; name: string } {
  const { families, role } = callsignOptions(type, task);
  const hit = typeof family === 'number'
    ? (families[family] !== undefined ? [family, families[family]] as const : undefined)
    : Object.entries(families).map(([n, s]) => [Number(n), s] as const).find(([, s]) => s.toLowerCase() === family.toLowerCase());
  if (!hit) throw new Error(`Callsign family '${family}' is not available for ${type} (${role}); available: ${Object.entries(families).map(([n, s]) => `${n} ${s}`).join(', ')}`);
  return { family: hit[0], name: hit[1].replace(/\s+/g, '') };
}
