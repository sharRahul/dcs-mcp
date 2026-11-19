import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claudeDesktopConfigPath,
  configureClaudeDesktop,
  isEphemeralPath,
  serverEntry,
} from '../src/dcs/claude-desktop.js';
import {
  buildManifest,
  MANIFEST_SCHEMA,
  MANIFEST_VERSION,
  SERVER_ENTRY_POINT,
} from '../scripts/claude-bundle-manifest.mjs';

/**
 * Registering with Claude Desktop means editing a file the app also keeps its own
 * settings in, so every case here is about NOT losing something: other servers,
 * other top-level keys, an entry the user pointed somewhere else, or a file we
 * cannot parse. The manifest half checks the bundle against the MCPB field list
 * without needing a build.
 */

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), 'dcs-desktop-'));
}

/** A real file to point `local` mode at; the module refuses a missing one. */
function fakeEntry(dir: string): string {
  const file = path.join(dir, 'index.js');
  writeFileSync(file, '// entry\n');
  return file;
}

test('config path follows each platform', () => {
  assert.equal(
    claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\p\\AppData\\Roaming' }),
    path.join('C:\\Users\\p\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json')
  );
  assert.equal(
    claudeDesktopConfigPath('darwin', { HOME: '/Users/p' }),
    path.join('/Users/p', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  );
  assert.equal(
    claudeDesktopConfigPath('linux', { HOME: '/home/p' }),
    path.join('/home/p', '.config', 'Claude', 'claude_desktop_config.json')
  );
  assert.equal(
    claudeDesktopConfigPath('linux', { HOME: '/home/p', XDG_CONFIG_HOME: '/cfg' }),
    path.join('/cfg', 'Claude', 'claude_desktop_config.json')
  );
  assert.throws(() => claudeDesktopConfigPath('win32', {}), /APPDATA/);
});

test('published mode goes through cmd on Windows, where the app spawns without a shell', () => {
  const win = serverEntry({ mode: 'published', platform: 'win32' });
  assert.deepEqual(win, { command: 'cmd', args: ['/c', 'npx', '-y', 'dcs-mcp-server'] });
  const mac = serverEntry({ mode: 'published', platform: 'darwin' });
  assert.deepEqual(mac, { command: 'npx', args: ['-y', 'dcs-mcp-server'] });
});

test('local mode names this Node and this script, and drops empty env values', () => {
  const dir = temp();
  const entry = serverEntry({
    mode: 'local',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    entryScript: fakeEntry(dir),
    env: { DCS_SAVED_GAMES: ' C:\\Saved Games\\DCS ', DCS_BRIDGE_HOST: '', DCS_INSTALL_DIR: undefined },
  });
  assert.equal(entry.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(entry.args, [path.join(dir, 'index.js')]);
  assert.deepEqual(entry.env, { DCS_SAVED_GAMES: 'C:\\Saved Games\\DCS' });
});

test('npx cache paths are rejected as entry scripts', () => {
  assert.equal(isEphemeralPath('/home/p/.npm/_npx/abc/node_modules/dcs-mcp-server/dist/index.js'), true);
  assert.equal(isEphemeralPath('C:\\Users\\p\\AppData\\Local\\npm-cache\\_npx\\a\\x.js'), true);
  assert.equal(isEphemeralPath('F:\\GitHub\\dcs-mcp\\dist\\index.js'), false);
});

test('a new config file is created with the entry', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'nested', 'claude_desktop_config.json');
  const result = await configureClaudeDesktop({
    configPath,
    mode: 'published',
    platform: 'darwin',
  });
  assert.equal(result.status, 'added');
  assert.equal(result.backup, undefined);
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(written, { mcpServers: { dcs: { command: 'npx', args: ['-y', 'dcs-mcp-server'] } } });
  assert.ok(result.notes.some((n) => /start it again/i.test(n)));
});

test('everything else in the file survives: other servers and the app preferences', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { blender: { command: 'blender-mcp.exe' } },
      coworkUserFilesPath: 'C:\\Users\\p\\Documents\\Claude',
      preferences: { sidebarMode: 'epitaxy', nested: { keep: [1, 2] } },
    })
  );
  const result = await configureClaudeDesktop({ configPath, mode: 'published', platform: 'win32' });
  assert.equal(result.status, 'added');
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(written.mcpServers.blender, { command: 'blender-mcp.exe' });
  assert.equal(written.coworkUserFilesPath, 'C:\\Users\\p\\Documents\\Claude');
  assert.deepEqual(written.preferences, { sidebarMode: 'epitaxy', nested: { keep: [1, 2] } });
  assert.deepEqual(written.mcpServers.dcs.args, ['/c', 'npx', '-y', 'dcs-mcp-server']);
  assert.ok(existsSync(result.backup!), 'the previous config is kept');
});

test('an existing dcs entry pointing elsewhere is left alone until forced', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  const original = { mcpServers: { dcs: { command: 'node', args: ['C:\\old\\index.js'] } } };
  writeFileSync(configPath, JSON.stringify(original));

  const refused = await configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' });
  assert.equal(refused.status, 'differs');
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), original);
  assert.ok(refused.notes.some((n) => /--force/.test(n)));

  const forced = await configureClaudeDesktop({
    configPath,
    mode: 'published',
    platform: 'darwin',
    overwrite: true,
  });
  assert.equal(forced.status, 'replaced');
  assert.ok(forced.backup && readdirSync(dir).some((f) => f.includes('.bak-')));
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.dcs, {
    command: 'npx',
    args: ['-y', 'dcs-mcp-server'],
  });

  const again = await configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' });
  assert.equal(again.status, 'unchanged');
  assert.equal(again.backup, undefined);
});

test('a second server name can be added alongside', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  await configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' });
  await configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin', serverName: 'dcs-dev' });
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(Object.keys(written.mcpServers).sort(), ['dcs', 'dcs-dev']);
});

test('a config we cannot parse is never overwritten', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  const broken = '{ "mcpServers": { "blender": {} }, }';
  writeFileSync(configPath, broken);
  await assert.rejects(
    configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' }),
    /not valid JSON/
  );
  assert.equal(readFileSync(configPath, 'utf8'), broken);

  writeFileSync(configPath, JSON.stringify({ mcpServers: [] }));
  await assert.rejects(
    configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' }),
    /not an object/
  );
});

test('an empty file is treated as a fresh config', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  writeFileSync(configPath, '\n');
  const result = await configureClaudeDesktop({ configPath, mode: 'published', platform: 'darwin' });
  assert.equal(result.status, 'added');
  assert.ok(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.dcs);
});

test('dry run reports the entry and writes nothing', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  const result = await configureClaudeDesktop({
    configPath,
    mode: 'published',
    platform: 'win32',
    dryRun: true,
  });
  assert.equal(result.status, 'would-add');
  assert.equal(existsSync(configPath), false);
});

test('local mode refuses a missing script and an npx cache path', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  await assert.rejects(
    configureClaudeDesktop({ configPath, mode: 'local', entryScript: path.join(dir, 'nope.js') }),
    /does not exist/
  );
  const cached = path.join(dir, '_npx', 'abc');
  mkdirSync(cached, { recursive: true });
  await assert.rejects(
    configureClaudeDesktop({ configPath, mode: 'local', entryScript: fakeEntry(cached) }),
    /cache/
  );
  assert.equal(existsSync(configPath), false);
});

test('default installer uses local paths and never falls back to an unavailable npm package', async () => {
  const dir = temp();
  const configPath = path.join(dir, 'claude_desktop_config.json');
  await assert.rejects(
    configureClaudeDesktop({ configPath, entryScript: path.join(dir, 'missing.js') }),
    /npm run build/
  );
  assert.equal(existsSync(configPath), false);
  const cached = path.join(dir, '_npx', 'abc');
  mkdirSync(cached, { recursive: true });
  await assert.rejects(configureClaudeDesktop({ configPath, entryScript: fakeEntry(cached) }), /cache/);
  assert.equal(existsSync(configPath), false);
  const entryScript = fakeEntry(dir);
  const result = await configureClaudeDesktop({ configPath, entryScript });
  assert.equal(result.mode, 'local');
  assert.equal(result.entry.command, process.execPath);
  assert.deepEqual(result.entry.args, [entryScript]);
});

test('the MCPB manifest carries every required field and only optional user config', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = buildManifest(pkg) as Record<string, any>;
  for (const field of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) {
    assert.ok(manifest[field] !== undefined, `missing ${field}`);
  }
  assert.equal(manifest.manifest_version, MANIFEST_VERSION);
  // The 0.4 schema sets additionalProperties: false, so $schema must name that same version.
  assert.equal(manifest.$schema, MANIFEST_SCHEMA);
  assert.match(manifest.$schema, new RegExp(`-v${MANIFEST_VERSION}\\.schema\\.json$`));
  assert.equal(manifest.version, pkg.version, 'the bundle version must track package.json');
  assert.ok(manifest.author.name);
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, SERVER_ENTRY_POINT);
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${SERVER_ENTRY_POINT}`]);
  assert.equal(manifest.server.mcp_config.command, 'node');
  // Claude Desktop ships Node, so no runtime is claimed beyond the version this server needs.
  assert.deepEqual(manifest.compatibility, { runtimes: { node: '>=20.0.0' } });

  const types = ['string', 'number', 'boolean', 'directory', 'file'];
  for (const [key, config] of Object.entries(manifest.user_config) as [string, any][]) {
    assert.ok(types.includes(config.type), `${key}: bad type ${config.type}`);
    assert.ok(config.title && config.description, `${key}: needs a title and description`);
    assert.equal(config.required ?? false, false, `${key} must not be required`);
  }
  // Every env token must name a user_config key, or Claude Desktop substitutes nothing.
  for (const value of Object.values(manifest.server.mcp_config.env) as string[]) {
    const match = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value);
    assert.ok(match, `env value '${value}' is not a user_config substitution`);
    assert.ok(manifest.user_config[match![1]], `env names unknown user_config.${match![1]}`);
  }
  assert.equal(manifest.user_config.bridge_host.default, '127.0.0.1');
  assert.equal(manifest.user_config.bridge_port.default, 8899);
});
