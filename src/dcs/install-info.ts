/**
 * What the DCS install on THIS machine actually is: where it lives, which build it is,
 * which terrains and modules are installed, and where that disagrees with the bundled
 * (pydcs 1.0.0-derived) catalogue.
 *
 * The bundled data is pinned to pydcs, so it is as old as that pin. A newer DCS adds
 * theatres (Iraq, Marianas WWII) and unit types the catalogue has never heard of, and
 * nothing in the data itself can say so. This module is the only place that compares the
 * two, so a client can be told "your install has a theatre this server has no data for"
 * instead of a bare "unknown theatre".
 *
 * Every file here is read as TEXT or JSON and never executed, like mods.ts and
 * liveries.ts, and nothing throws: an unreadable install yields fewer facts and a note.
 * pydcs states no DCS build number anywhere in its sources, so a *numeric* version
 * comparison is impossible — the drift this reports is coverage drift (theatres and
 * aircraft folders present in the install but absent from the data), which is evidence,
 * plus the installed build string so a human can judge the rest.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { packagePath } from '../paths.js';
import { theatres, resolveTheatreName, findUnitType } from '../data/reference.js';
import { defaultLogPath } from './log.js';
import { defaultInstallDirs, scanModFolder } from './mods.js';

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

const list = (d: string): string[] => { try { return existsSync(d) ? readdirSync(d) : []; } catch { return []; } };
const isDir = (d: string): boolean => { try { return statSync(d).isDirectory(); } catch { return false; } };
export function readText(file: string, maxBytes = MAX_TEXT_BYTES): string | undefined {
  try {
    if (statSync(file).size > maxBytes) return undefined;
    return readFileSync(file, 'utf8');
  } catch { return undefined; }
}

/** The install root looks right when it has the folders every DCS install has. */
function looksLikeInstall(dir: string): boolean {
  return isDir(path.join(dir, 'Mods')) && (isDir(path.join(dir, 'bin')) || isDir(path.join(dir, 'bin-mt')));
}

/**
 * Install roots, best first: DCS_INSTALL_DIR, the path DCS itself logged at startup
 * (`Command line: "<root>/bin/DCS.exe" ...` in dcs.log — the only record of a non-default
 * install location this server can read), then the default Program Files locations.
 */
export function findInstallDirs(env: NodeJS.ProcessEnv = process.env): { path: string; source: 'env' | 'log' | 'default' }[] {
  const out: { path: string; source: 'env' | 'log' | 'default' }[] = [];
  const add = (p: string | undefined, source: 'env' | 'log' | 'default') => {
    if (!p) return;
    const norm = path.normalize(p);
    const root = norm.replace(/[\\/]+$/, '');
    if (!looksLikeInstall(root) || out.some(o => o.path.toLowerCase() === root.toLowerCase())) return;
    out.push({ path: root, source });
  };
  add(env.DCS_INSTALL_DIR, 'env');
  add(installRootFromLog(env), 'log');
  for (const d of defaultInstallDirs(env)) add(d, 'default');
  return out;
}

/** `H:/DCS World/.../bin/DCS.exe` from dcs.log's command line -> the install root. */
export function installRootFromLog(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.DCS_LOG_PATH ?? defaultLogPath();
  const text = readText(file, 64 * 1024 * 1024);
  if (!text) return undefined;
  // Only the head of the log matters, and only the launcher's own line.
  const head = text.slice(0, 200_000);
  const m = /Command line:\s*"?([^"\n]*?[/\\])bin(?:-mt)?[/\\]DCS\.exe/i.exec(head);
  if (!m) return undefined;
  return path.normalize(m[1]);
}

export interface InstalledTheatre {
  /** Mods/terrains folder name, e.g. "Iraq", "MarianasWWII". */
  folder: string;
  /** `theatre.id` from entry.lua (what a .miz stores in mission.theatre), when stated. */
  id?: string;
  /** `update_id` from entry.lua, e.g. "IRAQ_terrain" — the autoupdate module name. */
  updateId?: string;
  /** The bundled theatres.json key this is, when the catalogue has it. */
  bundledKey?: string;
  /** Files this module ships that we can read as data. */
  files: { entry: boolean; radio: boolean; beacons: boolean };
}

export interface InstallInfo {
  root?: string;
  rootSource?: 'env' | 'log' | 'default';
  /** Build string from autoupdate.cfg (authoritative) or the `DCS/<version>` log line. */
  version?: string;
  versionSource?: 'autoupdate.cfg' | 'dcs.log';
  /** autoupdate.cfg timestamp (yyyymmdd-hhmmss), i.e. when this build was installed. */
  installedAt?: string;
  /** autoupdate.cfg module list (terrains, airframes, campaigns), verbatim. */
  modules: string[];
  theatres: InstalledTheatre[];
  /** CoreMods/aircraft folder names (one per stock airframe module). */
  aircraftModules: string[];
  notes: string[];
}

function parseAutoupdate(root: string): { version?: string; installedAt?: string; modules: string[] } {
  const text = readText(path.join(root, 'autoupdate.cfg'), 4 * 1024 * 1024);
  if (!text) return { modules: [] };
  try {
    const cfg = JSON.parse(text) as { version?: unknown; timestamp?: unknown; modules?: unknown };
    return {
      version: typeof cfg.version === 'string' ? cfg.version : undefined,
      installedAt: typeof cfg.timestamp === 'string' ? cfg.timestamp : undefined,
      modules: Array.isArray(cfg.modules) ? cfg.modules.filter((m): m is string => typeof m === 'string') : [],
    };
  } catch { return { modules: [] }; }
}

function versionFromLog(env: NodeJS.ProcessEnv): string | undefined {
  const text = readText(env.DCS_LOG_PATH ?? defaultLogPath(), 64 * 1024 * 1024);
  if (!text) return undefined;
  return /\bDCS\/(\d+(?:\.\d+)+)\b/.exec(text.slice(0, 200_000))?.[1];
}

/** entry.lua is a plugin declaration, read as text: only the two id fields are taken. */
function readTheatreEntry(folder: string): { id?: string; updateId?: string } {
  const text = readText(path.join(folder, 'entry.lua'), 1024 * 1024);
  if (!text) return {};
  const field = (name: string) =>
    new RegExp(`\\[?['"]${name}['"]\\]?\\s*=\\s*['"]([^'"\\n]{1,64})['"]`).exec(text)?.[1];
  return { id: field('id'), updateId: field('update_id') };
}

export function installedTheatres(root: string): InstalledTheatre[] {
  const terrains = path.join(root, 'Mods', 'terrains');
  const bundled = Object.keys(theatres());
  const out: InstalledTheatre[] = [];
  for (const folder of list(terrains)) {
    const dir = path.join(terrains, folder);
    if (!isDir(dir)) continue;
    const entry = readTheatreEntry(dir);
    const candidates = [entry.id, folder].filter((c): c is string => !!c);
    let bundledKey: string | undefined;
    for (const c of candidates) {
      bundledKey = resolveTheatreName(c) ?? bundled.find(b => b.toLowerCase() === c.toLowerCase());
      if (bundledKey) break;
    }
    out.push({
      folder, id: entry.id, updateId: entry.updateId, bundledKey,
      files: {
        entry: existsSync(path.join(dir, 'entry.lua')),
        radio: existsSync(path.join(dir, 'radio.lua')),
        beacons: existsSync(path.join(dir, 'beacons.lua')),
      },
    });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

let cache: { at: number; info: InstallInfo } | undefined;

export function installInfo(env: NodeJS.ProcessEnv = process.env, refresh = false): InstallInfo {
  if (!refresh && cache && Date.now() - cache.at < 60_000) return cache.info;
  const notes: string[] = [];
  const roots = findInstallDirs(env);
  if (!roots.length) {
    const info: InstallInfo = {
      modules: [], theatres: [], aircraftModules: [],
      notes: ['No DCS install folder found. Set DCS_INSTALL_DIR, or run DCS once so its path appears in dcs.log. ' +
        'Install-derived data (theatre radios, beacons, Mission Editor icons, payloads, liveries) is unavailable, not empty.'],
    };
    cache = { at: Date.now(), info };
    return info;
  }
  const root = roots[0];
  if (roots.length > 1) notes.push(`${roots.length} install folders found; using ${root.path} (${root.source}). Set DCS_INSTALL_DIR to pick another.`);
  const cfg = parseAutoupdate(root.path);
  let version = cfg.version, versionSource: InstallInfo['versionSource'] = cfg.version ? 'autoupdate.cfg' : undefined;
  if (!version) {
    version = versionFromLog(env);
    if (version) { versionSource = 'dcs.log'; notes.push('autoupdate.cfg was unreadable; the build string came from dcs.log.'); }
  }
  const info: InstallInfo = {
    root: root.path, rootSource: root.source, version, versionSource, installedAt: cfg.installedAt,
    modules: cfg.modules, theatres: installedTheatres(root.path),
    aircraftModules: list(path.join(root.path, 'CoreMods', 'aircraft')).filter(d => isDir(path.join(root.path, 'CoreMods', 'aircraft', d))).sort(),
    notes,
  };
  cache = { at: Date.now(), info };
  return info;
}

export interface CoverageReport {
  install: Pick<InstallInfo, 'root' | 'version' | 'versionSource' | 'installedAt'>;
  bundledSource: string;
  /** Installed terrains the bundled catalogue has no airfield/projection data for. */
  theatresWithoutData: { folder: string; id?: string; readableData: string[] }[];
  /** Bundled theatres that are not installed here (their data still works offline). */
  theatresNotInstalled: string[];
  /**
   * Unit type ids this install declares (CoreMods, scanned as text exactly as a mod is)
   * that the bundled catalogue has no entry for. These are the stock types the pinned
   * data predates — the measurable half of "your DCS is newer than this data".
   */
  typesNotInCatalogue: { type: string; module: string; file: string }[];
  notes: string[];
}

/**
 * Type ids declared by the install's own CoreMods, found with the same text scan used for
 * third-party mods (`make_flyable`, `add_aircraft` Name, `GT.Name` + `add_surface_unit`).
 * Nothing is executed and a folder that cannot be read simply yields fewer types.
 */
export function declaredInstallTypes(root: string): { type: string; module: string; file: string }[] {
  const out: { type: string; module: string; file: string }[] = [];
  for (const kind of ['aircraft', 'tech']) {
    const dir = path.join(root, 'CoreMods', kind);
    for (const name of list(dir)) {
      const folder = path.join(dir, name);
      if (!isDir(folder)) continue;
      try {
        const mod = scanModFolder(folder, kind);
        for (const unit of mod.units) out.push({ type: unit.type, module: `CoreMods/${kind}/${name}`, file: unit.file });
      } catch { /* unreadable module: fewer types, never a failure */ }
    }
  }
  return out;
}

/**
 * Where the install and the bundled catalogue disagree. This is the drift warning:
 * a numeric "data is older than DCS" comparison is not possible (pydcs never states the
 * DCS build it was exported from), so what is reported is what IS evidence — coverage.
 */
export function coverageReport(env: NodeJS.ProcessEnv = process.env): CoverageReport {
  const info = installInfo(env);
  const bundled = Object.keys(theatres());
  const missingTypes = info.root
    ? declaredInstallTypes(info.root)
        .filter(t => !findUnitType(t.type))
        .filter((t, i, all) => all.findIndex(o => o.type === t.type) === i)
        .sort((a, b) => a.type.localeCompare(b.type))
    : [];
  const dataSource = (() => {
    try { return String(JSON.parse(readFileSync(packagePath('data', 'theatres.json'), 'utf8'))._source ?? 'pydcs'); }
    catch { return 'pydcs'; }
  })();
  const theatresWithoutData = info.theatres.filter(t => !t.bundledKey).map(t => ({
    folder: t.folder, id: t.id,
    readableData: [t.files.radio ? 'radio.lua (ATC frequencies)' : '', t.files.beacons ? 'beacons.lua (TACAN/ILS/VOR/NDB)' : '']
      .filter(Boolean),
  }));
  const installedKeys = new Set(info.theatres.map(t => t.bundledKey).filter((k): k is string => !!k));
  const notes: string[] = [...info.notes];
  if (!info.root) notes.push('No install found: nothing to compare against.');
  if (theatresWithoutData.length) {
    notes.push(`${theatresWithoutData.length} installed terrain(s) have no bundled airfield or projection data: ` +
      `${theatresWithoutData.map(t => t.folder).join(', ')}. ATC and beacon data can still be read from the install ` +
      '(dcs_theatre_data); airfield ids, coordinates and parking need a live sample (dcs_airbase_build_pack while a mission on that map runs).');
  }
  if (missingTypes.length) {
    notes.push(`${missingTypes.length} unit type id(s) declared by this install are absent from the bundled catalogue ` +
      `(e.g. ${missingTypes.slice(0, 5).map(t => t.type).join(', ')}). They can still be used by exact id; the catalogue ` +
      'cannot describe them, and the text scan sees only types declared literally in Lua.');
  }
  notes.push('The bundled catalogue is pinned to ' + dataSource + ', which states no DCS build, so "is the data older than DCS" cannot be answered numerically. ' +
    'Coverage above is the measurable part.');
  return {
    install: { root: info.root, version: info.version, versionSource: info.versionSource, installedAt: info.installedAt },
    bundledSource: dataSource,
    theatresWithoutData,
    theatresNotInstalled: bundled.filter(b => !installedKeys.has(b)).sort(),
    typesNotInCatalogue: missingTypes,
    notes,
  };
}
