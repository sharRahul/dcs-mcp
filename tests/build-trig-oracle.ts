/**
 * Build tests/fixtures/trig-oracle.json from Mission-Editor-saved .miz files.
 *
 * Records only trigger predicate specs and the compiled Lua DCS produced for
 * them - no mission content, names or briefings - so the fixture is a format
 * oracle rather than a copy of anyone's mission.
 *
 * Usage:
 *   npx tsx tests/build-trig-oracle.ts "<missions folder>" tests/fixtures/trig-oracle.json
 *
 * Point it at a folder of missions saved by the DCS Mission Editor (for example
 * `Saved Games/DCS/Missions`). Rerun it after a DCS version bump to confirm the
 * trigger format has not changed.
 */
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { parseLuaAssignment, luaArray, asTable, type LuaTable } from "../src/miz/lua.js";

const SUPPORTED_CONDITIONS = new Set([
  "c_time_after", "c_time_since_flag", "c_flag_is_true", "c_flag_is_false", "c_flag_equals",
  "c_flag_more", "c_unit_in_zone", "c_unit_out_zone", "c_unit_dead", "c_group_dead",
  "c_group_life_less", "c_part_of_group_in_zone", "c_part_of_coalition_in_zone", "c_random_less",
]);
const SUPPORTED_ACTIONS = new Set([
  "a_out_text_delay", "a_out_text_delay_s", "a_out_text_delay_g", "a_out_text_delay_u",
  "a_out_text_delay_c",
  "a_set_flag", "a_set_flag_value", "a_clear_flag", "a_set_flag_random",
  "a_activate_group", "a_deactivate_group", "a_group_on", "a_group_off", "a_group_resume",
  "a_explosion", "a_effect_smoke", "a_signal_flare", "a_end_mission",
  "a_add_radio_item", "a_add_radio_item_for_group", "a_remove_radio_item",
  "a_remove_radio_item_for_group",
  "a_out_sound", "a_out_sound_s", "a_out_sound_g", "a_out_sound_stop", "a_radio_transmission",
  "a_do_script", "a_do_script_file",
  // Named `c_*` but stored in a trigrule's `actions` array by DCS.
  "c_start_wait_for_user", "c_stop_wait_for_user",
]);

/** Only the fields the compiler reads; ME writes many vestigial extras. */
const KEEP = new Set([
  "predicate", "seconds", "flag", "value", "unit", "zone", "group", "percent", "coalitionlist",
  "unitType", "text", "KeyDict_text", "clearview", "start_delay", "altitude", "volume", "preset",
  "density", "name", "color", "bearing", "winner",
  "flag_back", "min_value", "max_value", "countrylist",
  "radiotext", "KeyDict_radiotext",
  "file", "frequency", "power", "modulation", "loop", "mic_effects", "squelch_effects",
]);

function trim(entry: LuaTable): LuaTable {
  const out: LuaTable = {};
  for (const k of Object.keys(entry)) if (KEEP.has(k)) out[k] = entry[k];
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  let ents: string[]; try { ents = readdirSync(dir); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, acc); else if (e.toLowerCase().endsWith(".miz")) acc.push(p);
  }
  return acc;
}

function splitCalls(src: string): string[] {
  const out: string[] = [];
  let depth = 0, inStr = false, esc = false, cur = "";
  for (const ch of src) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (inStr) { cur += ch; if (ch === '"') inStr = false; continue; }
    if (ch === '"') { cur += ch; inStr = true; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === ";" && depth === 0) { const t = cur.trim(); if (t) out.push(t); cur = ""; continue; }
    cur += ch;
  }
  const t = cur.trim(); if (t) out.push(t);
  return out;
}

function splitConds(src: string): string[] {
  const m = /^return\((.*)\)\s*$/s.exec(src.trim());
  if (!m) return [];
  const body = m[1];
  const out: string[] = [];
  let depth = 0, inStr = false, esc = false, cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (inStr) { cur += ch; if (ch === '"') inStr = false; continue; }
    if (ch === '"') { cur += ch; inStr = true; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && body.startsWith(" and ", i)) { const t = cur.trim(); if (t) out.push(t); cur = ""; i += 4; continue; }
    cur += ch;
  }
  const t = cur.trim(); if (t) out.push(t);
  return out;
}

/**
 * `role` is recorded rather than inferred from the name: DCS stores
 * `c_start_wait_for_user` in a trigrule's ACTIONS array despite the `c_` prefix.
 */
interface PredicateCase { predicate: string; role: "condition" | "action"; spec: LuaTable; lua: string }
interface RuleCase {
  type: string; index: number;
  rules: LuaTable[]; actions: LuaTable[];
  condition: string; action: string; func?: string; funcStartup?: string;
}

/**
 * Some missions carry a stale `trig` (edited trigrules saved by an older DCS),
 * so a single sample can disagree with its own spec. Collect every candidate and
 * pick from the largest group of identically-shaped compiled calls.
 */
const candidates = new Map<string, PredicateCase[]>();
// Argument values collapse to one placeholder because DCS accepts either a
// number or a string for flag ids; only the CALL SHAPE distinguishes formats.
function template(lua: string): string {
  return lua.replace(/"(\\.|[^"\\])*"/g, "V").replace(/-?\d+(\.\d+)?/g, "V");
}
function pickMajority(list: PredicateCase[]): PredicateCase {
  const groups = new Map<string, PredicateCase[]>();
  for (const c of list) {
    const key = template(c.lua);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length)[0][0];
}

const predicateCases = new Map<string, PredicateCase>();
const ruleCases: RuleCase[] = [];
const seenRuleShape = new Set<string>();

for (const f of walk(process.argv[2])) {
  let mission: LuaTable;
  try {
    const zip = new AdmZip(f);
    const me = zip.getEntry("mission"); if (!me) continue;
    mission = parseLuaAssignment(me.getData().toString("utf8"), "mission");
  } catch { continue; }

  const trig = asTable(mission["trig"]);
  const conds = asTable(trig?.["conditions"]);
  const acts = asTable(trig?.["actions"]);
  const funcs = asTable(trig?.["func"]);
  const startups = asTable(trig?.["funcStartup"]);

  luaArray(mission["trigrules"]).forEach((rule, i) => {
    const index = i + 1;
    const type = String(rule["predicate"]);
    const specConds = luaArray(rule["rules"]);
    const specActs = luaArray(rule["actions"]);
    const condSrc = conds?.[index];
    const actSrc = acts?.[index];
    if (typeof condSrc !== "string" || typeof actSrc !== "string") return;

    const supported =
      specConds.every((c) => SUPPORTED_CONDITIONS.has(String(c["predicate"]))) &&
      specActs.every((a) => SUPPORTED_ACTIONS.has(String(a["predicate"]))) &&
      specActs.length > 0;

    // Per-predicate cases: align each sub-call with its spec.
    const condParts = splitConds(condSrc);
    if (condParts.length === specConds.length) {
      specConds.forEach((c, j) => {
        const p = String(c["predicate"]);
        if (!SUPPORTED_CONDITIONS.has(p)) return;
        const key = "c:" + p;
        (candidates.get(key) ?? candidates.set(key, []).get(key)!).push({ predicate: p, role: "condition", spec: trim(c), lua: condParts[j] });
      });
    }
    const actParts = splitCalls(actSrc.replace(/\s*mission\.trig\.func\[\d+\]=nil;\s*$/, ""));
    if (actParts.length === specActs.length) {
      specActs.forEach((a, j) => {
        const p = String(a["predicate"]);
        if (!SUPPORTED_ACTIONS.has(p)) return;
        const key = "a:" + p;
        (candidates.get(key) ?? candidates.set(key, []).get(key)!).push({ predicate: p, role: "action", spec: trim(a), lua: actParts[j] });
      });
    }

    // Whole-trigger cases, one per (type, nConditions, nActions) shape. Only
    // triggers whose func/funcStartup wiring is present can be checked end to end.
    if (!supported) return;
    if (condParts.length !== specConds.length || actParts.length !== specActs.length) return;
    const func = typeof funcs?.[index] === "string" ? (funcs[index] as string) : undefined;
    const funcStartup = typeof startups?.[index] === "string" ? (startups[index] as string) : undefined;
    if (type === "triggerStart" ? !funcStartup : !func) return;
    if (type === "triggerOnce" && !actSrc.endsWith(`mission.trig.func[${index}]=nil;`)) return;
    ruleCases.push({
      type, index,
      rules: specConds.map(trim), actions: specActs.map(trim),
      condition: condSrc, action: actSrc, func, funcStartup,
    });
  });
}

for (const [key, list] of candidates) predicateCases.set(key, pickMajority(list));

// Drop whole-trigger cases whose sub-calls do not match the majority format for
// their predicate: those come from missions with a stale, older-format `trig`.
const majorityTemplate = new Map<string, string>();
for (const [key, c] of predicateCases) majorityTemplate.set(key, template(c.lua));
const consistent = ruleCases.filter((r) => {
  const parts = [
    ...splitConds(r.condition).map((lua, j) => ["c:" + String(r.rules[j]["predicate"]), lua] as const),
    ...splitCalls(r.action.replace(/\s*mission\.trig\.func\[\d+\]=nil;\s*$/, "")).map(
      (lua, j) => ["a:" + String(r.actions[j]["predicate"]), lua] as const
    ),
  ];
  return parts.every(([key, lua]) => majorityTemplate.get(key) === template(lua));
});

const selected: RuleCase[] = [];
for (const r of consistent) {
  const shape = `${r.type}:${r.rules.length}:${r.actions.length}`;
  if (seenRuleShape.has(shape) || selected.length >= 40) continue;
  seenRuleShape.add(shape);
  selected.push(r);
}

mkdirSync(path.dirname(process.argv[3]), { recursive: true });
writeFileSync(process.argv[3], JSON.stringify({
  note:
    "Trigger format oracle captured from DCS Mission-Editor-saved .miz files. " +
    "Each entry pairs a mission.trigrules spec with the mission.trig Lua DCS compiled for it. " +
    "Regenerate with tests/build-trig-oracle.ts against a folder of ME-saved missions.",
  predicates: [...predicateCases.values()].sort((a, b) => a.predicate.localeCompare(b.predicate)),
  rules: selected,
}, null, 2) + "\n");
console.error(`predicates: ${predicateCases.size}, rules: ${selected.length} (of ${ruleCases.length} candidates)`);
