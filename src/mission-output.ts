/** Public MCP mission destinations; internal archive staging keeps explicit paths. */
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';

export function missionOutputDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.DCS_MISSION_OUTPUT_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error('DCS_MISSION_OUTPUT_DIR must be an absolute directory');
  return configured || path.join(home, 'Saved Games', 'DCS', 'Missions', 'My Mission');
}

export async function missionOutputPath(requested: string, mission = true): Promise<string> {
  const name = path.win32.basename(requested);
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
      || (mission && !name.toLowerCase().endsWith('.miz'))) {
    throw new Error(mission ? 'Choose a valid mission filename ending in .miz' : 'Choose a valid project or kit folder name');
  }
  const root = missionOutputDirectory();
  await mkdir(root, { recursive: true });
  return path.join(root, name);
}

export async function requireMissionProject(projectDir: string): Promise<string> {
  const root = await realpath(missionOutputDirectory());
  const project = await realpath(projectDir);
  const relative = path.relative(root, project);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Mission projects must be inside ' + root + '. Create a new project there or export its mission with dcs_miz_save_as.');
  }
  return project;
}
