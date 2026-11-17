/**
 * DCS campaign files (`.cmp`): read, validate, build and step.
 *
 * A `.cmp` is NOT an archive. It is a plain Lua chunk that assigns one table,
 * `campaign = { ... }`, which DCS loads with `loadfile` + `setfenv` into an
 * empty environment. This module parses it as DATA (`lua.ts` only evaluates
 * literals) and never executes it.
 *
 * Everything about the format and about progression below is taken from ED's own
 * campaign code, read as text from the installed game:
 *   - `MissionEditor/modules/me_campaign.lua` - `loadCampaign`, locale fallback,
 *     `checkCampaignIntegrity`, `createNewGame`, `chooseNextMission`.
 *   - `MissionEditor/modules/me_campaign_editor.lua` - `saveCampaign`,
 *     `getNecessaryUnits`, `getTypePlayerUnit`, and the editor's own defaults for
 *     a new stage (`missions = {}`) and a new mission (`interval = {0, 100}`,
 *     `skipScore = 100`).
 *
 * That makes the field list and the progression rules first-party, not inferred.
 * What is NOT established: nothing here has been run by DCS as a campaign from a
 * file this project wrote. Treat `writeCampaignFile` as offline-correct only.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { parseLuaAssignment, asTable, luaArray, type LuaTable, type LuaValue } from "../miz/lua.js";
import { serializeLuaAssignment } from "../miz/serializer.js";
import { atomicWrite } from "../security/files.js";

/** `version` in every campaign ED ships that carries one. */
export const CAMPAIGN_VERSION = 1;

/** The editor's default for a mission the author has not restricted. */
export const DEFAULT_INTERVAL: [number, number] = [0, 100];
/** `me_campaign_editor.lua` seeds a new mission with this. */
export const DEFAULT_SKIP_SCORE = 100;

export interface CampaignMission {
  file: string;
  /** `[min, max]`: the mission is a candidate when min <= result <= max. */
  interval: [number, number];
  description?: string;
  skipScore?: number;
  /** ED recomputes this on load; it is written for the editor's benefit only. */
  fullpath?: string;
}
export interface CampaignStage {
  name: string;
  missions: CampaignMission[];
}
export interface Campaign {
  name: string;
  description?: string;
  startStage: number;
  stages: CampaignStage[];
  picture?: string;
  pictureSuccess?: string;
  pictureFailed?: string;
  /** Module id -> module id, as ED writes it. */
  necessaryUnits?: Record<string, string>;
  version?: number;
  directory?: string;
  /** Every other key the file carried, preserved on a round trip. */
  extra?: Record<string, LuaValue>;
}

const interval = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]);
const missionSchema = z
  .object({
    file: z.string().min(1).max(260).describe("Mission file name, no directory: it must sit beside the .cmp."),
    interval: interval.default(DEFAULT_INTERVAL),
    description: z.string().max(100000).optional(),
    skipScore: z.number().min(0).max(100).optional(),
  })
  .strict();
export const campaignSpecSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(100000).optional(),
    startStage: z.number().int().positive().default(1),
    stages: z
      .array(z.object({ name: z.string().min(1).max(200), missions: z.array(missionSchema).min(1).max(50) }).strict())
      .min(1)
      .max(50),
    picture: z.string().max(260).optional(),
    pictureSuccess: z.string().max(260).optional(),
    pictureFailed: z.string().max(260).optional(),
    /** Module ids the campaign needs. Left out, it is derived from the missions. */
    necessaryUnits: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .strict();

// --- reading ---------------------------------------------------------------

/** Keys this module models; everything else is carried through untouched. */
const KNOWN_KEYS = new Set([
  "name", "description", "startStage", "stages", "picture", "pictureSuccess", "pictureFailed",
  "necessaryUnits", "version", "directory", "fullPath",
]);

/**
 * Parse a `.cmp`'s text. ED resolves `name`/`description`/`picture` through
 * `name_<LOCALE>` then `name_EN` then the bare key; the localised variants are
 * kept in `extra` so a round trip does not drop anyone's translations.
 */
export function parseCampaign(text: string): Campaign {
  const table = parseLuaAssignment(text, "campaign");
  const stages: CampaignStage[] = [];
  const stageTable = asTable(table["stages"]);
  // ED iterates `for i = 1, #campaign.stages`, so the stage list is an array and
  // its order is the ladder. Keys are read in numeric order for exactly that.
  for (const key of Object.keys(stageTable ?? {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b)) {
    const stage = asTable(stageTable?.[key]);
    if (!stage) continue;
    stages.push({
      name: typeof stage["name"] === "string" ? stage["name"] : `Stage ${key}`,
      missions: luaArray(stage["missions"]).map((m) => ({
        file: String(m["file"] ?? ""),
        interval: readInterval(m["interval"]),
        ...(typeof m["description"] === "string" ? { description: m["description"] } : {}),
        ...(typeof m["skipScore"] === "number" ? { skipScore: m["skipScore"] } : {}),
        ...(typeof m["fullpath"] === "string" ? { fullpath: m["fullpath"] } : {}),
      })),
    });
  }
  const extra: Record<string, LuaValue> = {};
  for (const [k, v] of Object.entries(table)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  const units = asTable(table["necessaryUnits"]);
  return {
    name: String(table["name"] ?? ""),
    ...(typeof table["description"] === "string" ? { description: table["description"] } : {}),
    startStage: typeof table["startStage"] === "number" ? table["startStage"] : 1,
    stages,
    ...(typeof table["picture"] === "string" ? { picture: table["picture"] } : {}),
    ...(typeof table["pictureSuccess"] === "string" ? { pictureSuccess: table["pictureSuccess"] } : {}),
    ...(typeof table["pictureFailed"] === "string" ? { pictureFailed: table["pictureFailed"] } : {}),
    ...(units
      ? {
          necessaryUnits: Object.fromEntries(
            Object.entries(units).filter(([, v]) => typeof v === "string") as [string, string][]
          ),
        }
      : {}),
    ...(typeof table["version"] === "number" ? { version: table["version"] } : {}),
    ...(typeof table["directory"] === "string" ? { directory: table["directory"] } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function readInterval(value: LuaValue | undefined): [number, number] {
  const t = asTable(value);
  const min = t?.[1];
  const max = t?.[2];
  return [typeof min === "number" ? min : DEFAULT_INTERVAL[0], typeof max === "number" ? max : DEFAULT_INTERVAL[1]];
}

export interface ReadCampaignResult {
  path: string;
  sha256: string;
  campaign: Campaign;
  /** Locale-suffixed keys the file carries (`name_RU`, `picture_EN`, ...). */
  localisedKeys: string[];
}

export async function readCampaignFile(file: string): Promise<ReadCampaignResult> {
  if (!file.toLowerCase().endsWith(".cmp")) throw new Error(`Not a .cmp file: ${file}`);
  const bytes = await readFile(file);
  const campaign = parseCampaign(bytes.toString("utf8"));
  return {
    path: file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    campaign,
    localisedKeys: Object.keys(campaign.extra ?? {}).filter((k) => /_[A-Z]{2}$/.test(k)),
  };
}

// --- validation ------------------------------------------------------------

export interface CampaignFinding {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidateCampaignOptions {
  /** Folder the `.cmp` lives in; mission files are resolved against it. */
  directory?: string;
  /** Theatre per mission file, when known, to catch a mixed-terrain campaign. */
  theatres?: Record<string, string>;
}

/**
 * Check a campaign the way DCS does, plus the ladder checks ED's own code makes
 * at RUN time rather than at load time.
 *
 * `error` means DCS will refuse the campaign or dead-end inside it:
 *   - `checkCampaignIntegrity` returns false for an empty stage or a missing
 *     mission file, and the editor shows the error and will not start it;
 *   - `chooseNextMission` prints `error: no mission chosen` and stops when no
 *     mission in the next stage matches the score it arrived with.
 */
export function validateCampaign(campaign: Campaign, options: ValidateCampaignOptions = {}): {
  findings: CampaignFinding[];
  stages: number;
  missions: number;
} {
  const findings: CampaignFinding[] = [];
  const add = (code: string, severity: CampaignFinding["severity"], message: string) =>
    findings.push({ code, severity, message });

  if (!campaign.stages.length) add("CAMPAIGN_NO_STAGES", "error", "A campaign needs at least one stage.");
  campaign.stages.forEach((stage, i) => {
    const n = i + 1;
    // ED: `if #stage.missions < 1 then showError(emptyStage)` and refuse.
    if (!stage.missions.length) add("STAGE_EMPTY", "error", `Stage ${n} ('${stage.name}') has no missions; DCS refuses the campaign.`);
    stage.missions.forEach((m, j) => {
      if (!m.file) add("MISSION_NO_FILE", "error", `Stage ${n} mission ${j + 1} has no file name.`);
      if (m.file.includes("/") || m.file.includes("\\")) {
        add(
          "MISSION_FILE_HAS_PATH",
          "error",
          `Stage ${n} mission ${j + 1} ('${m.file}') must be a bare file name: DCS resolves it as directory .. file.`
        );
      }
      const [min, max] = m.interval;
      if (min > max) add("MISSION_INTERVAL_INVERTED", "error", `Stage ${n} mission ${j + 1} has interval [${min}, ${max}].`);
    });
    // ED picks the next mission by `interval[1] <= result <= interval[2]`, so a
    // score no mission covers is a dead end. The reachable scores differ per
    // stage, but 0..100 integers cover every case DCS can hand it.
    const uncovered: number[] = [];
    for (let score = 0; score <= 100; score++) {
      if (!stage.missions.some((m) => m.interval[0] <= score && score <= m.interval[1])) uncovered.push(score);
    }
    if (uncovered.length && stage.missions.length) {
      add(
        "STAGE_SCORE_GAP",
        "error",
        `Stage ${n} ('${stage.name}') has no mission for score${uncovered.length > 1 ? "s" : ""} ` +
          `${summariseRanges(uncovered)}; arriving with one of those stops the campaign ('no mission chosen').`
      );
    }
  });

  if (campaign.startStage < 1 || campaign.startStage > campaign.stages.length) {
    add(
      "START_STAGE_OUT_OF_RANGE",
      "error",
      `startStage ${campaign.startStage} is outside 1..${campaign.stages.length}.`
    );
  } else {
    // ED's createNewGame picks the FIRST mission at random among those whose
    // interval's right bound is 100, and only falls back to mission 1 with a log
    // line if there are none.
    const start = campaign.stages[campaign.startStage - 1];
    if (start && !start.missions.some((m) => m.interval[1] === 100)) {
      add(
        "START_STAGE_NO_OPENER",
        "warning",
        `No mission in the start stage has an interval ending at 100, so DCS logs ` +
          `'No missions with right bound equal to 100 found, choosing first mission' and always opens with mission 1.`
      );
    }
  }

  const theatres = new Set(Object.values(options.theatres ?? {}));
  if (theatres.size > 1) {
    add(
      "CAMPAIGN_MIXED_THEATRES",
      "warning",
      `Missions span ${[...theatres].sort().join(", ")}. DCS checks every mission's terrain is installed before ` +
        `the campaign starts, so each one has to be owned.`
    );
  }

  return {
    findings,
    stages: campaign.stages.length,
    missions: campaign.stages.reduce((n, s) => n + s.missions.length, 0),
  };
}

/** "3, 7-9" from [3, 7, 8, 9]: short enough to read in an error message. */
function summariseRanges(values: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    out.push(i === j ? String(values[i]) : `${values[i]}-${values[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** Resolve each mission file against the campaign folder and report what is missing. */
export async function checkCampaignFiles(
  campaign: Campaign,
  directory: string
): Promise<{ present: string[]; missing: string[] }> {
  const present: string[] = [];
  const missing: string[] = [];
  for (const stage of campaign.stages) {
    for (const mission of stage.missions) {
      if (!mission.file) continue;
      const full = path.join(directory, mission.file);
      try {
        const st = await stat(full);
        (st.isFile() ? present : missing).push(mission.file);
      } catch {
        missing.push(mission.file);
      }
    }
  }
  return { present: [...new Set(present)], missing: [...new Set(missing)] };
}

// --- progression -----------------------------------------------------------

export interface CampaignStep {
  /** 1-based stage the player is about to fly, or null when the campaign ended. */
  stage: number | null;
  outcome: "advance" | "repeat" | "retreat" | "won" | "lost";
  /** Every mission in that stage whose interval contains the score. */
  candidates: { file: string; interval: [number, number] }[];
  rule: string;
}

/**
 * Where a campaign goes after a mission, exactly as `chooseNextMission` does it:
 * a score above 50 (or a skipped mission) moves up a stage, 50 repeats the
 * stage, below 50 moves down, and running off either end wins or loses the
 * campaign. The next mission is drawn at RANDOM from the stage's missions whose
 * interval contains the score, so every candidate is returned rather than one
 * being invented.
 */
export function stepCampaign(
  campaign: Campaign,
  from: { stage: number; result: number; skipped?: boolean }
): CampaignStep {
  const rule =
    "ED's chooseNextMission: result > 50 or skipped -> stage + 1; result == 50 -> same stage; " +
    "result < 50 -> stage - 1. Past the last stage the campaign is won, below stage 1 it is lost. " +
    "In the new stage every mission whose interval contains the result is a candidate and DCS picks one at random.";
  if (from.stage < 1 || from.stage > campaign.stages.length) {
    throw new Error(`Stage ${from.stage} is outside 1..${campaign.stages.length}`);
  }
  let stage: number;
  let outcome: CampaignStep["outcome"];
  if (from.result > 50 || from.skipped === true) {
    stage = from.stage + 1;
    outcome = "advance";
    if (stage > campaign.stages.length) return { stage: null, outcome: "won", candidates: [], rule };
  } else if (from.result === 50) {
    stage = from.stage;
    outcome = "repeat";
  } else {
    stage = from.stage - 1;
    outcome = "retreat";
    if (stage < 1) return { stage: null, outcome: "lost", candidates: [], rule };
  }
  const candidates = campaign.stages[stage - 1].missions
    .filter((m) => m.interval[0] <= from.result && from.result <= m.interval[1])
    .map((m) => ({ file: m.file, interval: m.interval }));
  return { stage, outcome, candidates, rule };
}

// --- writing ---------------------------------------------------------------

/**
 * `getTypePlayerUnit`: the type of the first unit with `skill == "Player"`,
 * looking through plane groups before helicopter groups, per country. ED uses it
 * to fill `necessaryUnits`, so a campaign states the modules it needs.
 */
export function playerUnitType(mission: LuaTable): string | undefined {
  for (const coalition of Object.values(asTable(mission["coalition"]) ?? {})) {
    for (const country of luaArray(asTable(coalition)?.["country"])) {
      for (const category of ["plane", "helicopter"] as const) {
        for (const group of luaArray(asTable(country[category])?.["group"])) {
          for (const unit of luaArray(asTable(group["units"]))) {
            if (unit["skill"] === "Player" && typeof unit["type"] === "string") return unit["type"];
          }
        }
      }
    }
  }
  return undefined;
}

export interface BuildCampaignOptions {
  /** Module ids for `necessaryUnits`, usually from `playerUnitType` per mission. */
  necessaryUnits?: string[];
  /**
   * Folder the campaign and its missions live in. ED stores it and recomputes
   * each `fullpath` from it on load, so it is informational.
   */
  directory?: string;
}

/** Build the table a `.cmp` holds, in the shape the editor's own save produces. */
export function buildCampaignTable(
  spec: z.output<typeof campaignSpecSchema>,
  options: BuildCampaignOptions = {}
): LuaTable {
  const stages: LuaTable = {};
  spec.stages.forEach((stage, i) => {
    const missions: LuaTable = {};
    stage.missions.forEach((mission, j) => {
      const interval: LuaTable = {};
      interval[1] = mission.interval[0];
      interval[2] = mission.interval[1];
      missions[j + 1] = {
        file: mission.file,
        interval,
        description: mission.description ?? "",
        skipScore: mission.skipScore ?? DEFAULT_SKIP_SCORE,
        // ED overwrites this from `directory .. file` when it loads the file.
        ...(options.directory ? { fullpath: `${options.directory.replace(/[\\/]*$/, "/")}${mission.file}` } : {}),
      };
    });
    stages[i + 1] = { name: stage.name, missions };
  });

  const units = spec.necessaryUnits ?? options.necessaryUnits ?? [];
  const necessaryUnits: LuaTable = {};
  for (const id of new Set(units)) necessaryUnits[id] = id;

  const table: LuaTable = {
    name: spec.name,
    description: spec.description ?? "",
    startStage: spec.startStage,
    version: CAMPAIGN_VERSION,
    stages,
    necessaryUnits,
    ...(spec.picture ? { picture: spec.picture } : {}),
    ...(spec.pictureSuccess ? { pictureSuccess: spec.pictureSuccess } : {}),
    ...(spec.pictureFailed ? { pictureFailed: spec.pictureFailed } : {}),
    ...(options.directory ? { directory: `${options.directory.replace(/[\\/]*$/, "/")}` } : {}),
  };
  return table;
}

export interface WriteCampaignResult {
  path: string;
  sha256: string;
  stages: number;
  missions: number;
  findings: CampaignFinding[];
  missingMissions: string[];
  notes: string[];
}

/**
 * Write a `.cmp`. The mission files are NOT copied: DCS resolves every
 * `file` against the campaign's own folder, so they have to be there already,
 * and this reports the ones that are not instead of moving anyone's missions.
 */
export async function writeCampaignFile(
  outPath: string,
  spec: z.input<typeof campaignSpecSchema>,
  options: BuildCampaignOptions & { overwrite?: boolean } = {}
): Promise<WriteCampaignResult> {
  if (!outPath.toLowerCase().endsWith(".cmp")) throw new Error(`Output path must end in .cmp: ${outPath}`);
  const parsed = campaignSpecSchema.parse(spec);
  const directory = options.directory ?? path.dirname(path.resolve(outPath));
  const table = buildCampaignTable(parsed, { ...options, directory });
  const campaign = parseCampaign(serializeLuaAssignment("campaign", table));
  const { findings } = validateCampaign(campaign, { directory });
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length) {
    throw new Error(
      `Refusing to write a campaign DCS cannot run: ${errors.map((e) => `${e.code}: ${e.message}`).join(" ")}`
    );
  }
  const files = await checkCampaignFiles(campaign, directory);
  const text = serializeLuaAssignment("campaign", table);
  // Parse what will be written, so a file DCS could not load never reaches disk.
  parseCampaign(text);
  const bytes = Buffer.from(text, "utf8");
  await atomicWrite(outPath, bytes, { overwrite: options.overwrite ?? false });
  return {
    path: outPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    stages: campaign.stages.length,
    missions: campaign.stages.reduce((n, s) => n + s.missions.length, 0),
    findings,
    missingMissions: files.missing,
    notes: [
      "Field list and progression rules come from ED's own me_campaign.lua and me_campaign_editor.lua, read as text.",
      "Mission files are not copied: DCS resolves each one as <campaign folder>/<file>, so they must sit beside this .cmp.",
      "necessaryUnits names the modules DCS requires; it is the player unit type of each mission, as the editor derives it.",
      "No campaign written by this project has been run by DCS yet: this is offline-correct, not flight-verified.",
    ],
  };
}
