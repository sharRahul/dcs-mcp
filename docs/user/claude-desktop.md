# Claude Desktop setup

Two ways to give the Claude Desktop app the DCS tools. Both run the same stdio server
locally: nothing about a mission leaves the machine, and DCS can stay closed while you
author or inspect one.

The npm package is not released. Use a permanent GitHub clone or build an extension from it. Neither route needs an npm account. Future registry installation is described only in the [release guide](../development/releasing.md#after-publication).

| | One command | One click |
|---|---|---|
| What you run | `node dist/index.js install-claude-desktop --local` | a built `dcs-mcp-<version>.mcpb` |
| Where the server comes from | a permanent built clone | packed inside the extension |
| Needs Node.js on the machine | yes | no — Claude Desktop ships its own |
| Needs internet | for cloning and installing build dependencies; not for starting the server | for building; not for installing the built extension |
| Updates | pull changes, install dependencies and rebuild the clone | build and install a new `.mcpb` |

## One command: merge an entry into claude_desktop_config.json

With Git and Node 20+ installed, run each command in order. Stop if a command fails:

```powershell
git clone https://github.com/sharRahul/dcs-mcp.git
cd dcs-mcp
npm ci
npm run build
node dist/index.js install-claude-desktop --local
```

If you already have a clone, start from its root and skip the first two commands. Keep it at the configured location. Quit Claude Desktop completely and restart it, then open a new chat and ask it to list the DCS tools.

| Flag | Effect |
|---|---|
| `--published` | Future npm mode; requires a published package. See the release guide before using it. |
| `--local` | this install's own `node` and `dist/index.js`, by absolute path |
| `--config <file>` | a config file other than the platform default |
| `--name <key>` | the key under `mcpServers` (default `dcs`) |
| `--saved-games <dir>` | `DCS_SAVED_GAMES` for the entry |
| `--dcs-install <dir>` | `DCS_INSTALL_DIR` |
| `--bridge-host <host>` / `--bridge-port <port>` | where the live hook listens |
| `--ffmpeg <exe>` | `DCS_FFMPEG_PATH`, only needed for mission audio |
| `--dry-run` | print the entry, write nothing |
| `--force` | replace an existing entry of that name |

Default config file: `%APPDATA%\Claude\claude_desktop_config.json` on Windows,
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`$XDG_CONFIG_HOME/Claude/…` (else `~/.config/Claude/…`) elsewhere. With no mode flag it uses
`--local` and says so when `dist/index.js` is missing — it never switches to `--published` on
your behalf, because that entry cannot start until the package is released.

What it refuses to do, because each of these breaks the app silently:

- **Rewrite the file.** That JSON also holds Claude Desktop's own `preferences`, so the
  entry is merged into the parsed object and every other key keeps its place. The previous
  file is copied to `<config>.bak-<timestamp>` first.
- **Touch a file it cannot parse.** A config with a trailing comma makes Claude Desktop
  start with no MCP servers and no message; the installer reports the parse error and
  changes nothing.
- **Replace an entry pointing somewhere else** without `--force`.
- **Pin the app to an `npx` cache path.** `--local` is refused when the entry script sits
  under `_npx`, `.npm-cache` or `_cacache`: npx may clear those at any time.

Local mode writes the running Node executable and the built entry script by absolute path. It does not depend on `npx`, a global npm installation of this package or Claude Desktop's working directory. To inspect the entry without changing your settings, append `--dry-run`. See the [technical reference](../reference/technical-reference.md#client-configuration) for a manual local configuration.

## One click: an MCPB extension

```powershell
npm ci
npm run bundle:build     # writes dcs-mcp-<version>.mcpb in the repository root
npm run bundle:validate  # Anthropic's mcpb CLI checks manifest.json
npm run bundle:verify
```

`bundle:build` compiles this checkout, copies the files the npm package publishes, installs
production dependencies from `package-lock.json` with install scripts disabled, writes
`manifest.json`, and zips the result. Nothing is downloaded when the extension is installed.
Install it by double-clicking the `.mcpb`, or through Claude Desktop's extension settings,
then start a new chat.

Declaration files and sourcemaps are pruned on the way in (1579 of them), matching what the
official `mcpb pack` leaves out: 3264 entries, 5.1 MB.

The manifest follows the MCPB spec (`manifest_version` `0.4` plus the matching `$schema`,
server type `node`, `entry_point` `server/dist/index.js`, `command` `node` with
`${__dirname}`), and is generated from `package.json` by
`scripts/build/claude-bundle-manifest.mjs` so the version cannot drift. `npm run bundle:validate`
checks it with Anthropic's own CLI (`mcpb validate`, a dev dependency), which matters because
the 0.4 schema rejects unknown keys outright.
Claude Desktop asks for five settings, all optional, each mapped to the environment variable
the server already reads:

| Setting | Variable | Default when left empty |
|---|---|---|
| DCS Saved Games folder | `DCS_SAVED_GAMES` | `Saved Games/DCS`, then `DCS.openbeta` |
| DCS install folder | `DCS_INSTALL_DIR` | the path DCS logs at startup, then Program Files |
| Live bridge host | `DCS_BRIDGE_HOST` | `127.0.0.1` |
| Live bridge port | `DCS_BRIDGE_PORT` | `8899` |
| FFmpeg executable | `DCS_FFMPEG_PATH` | `ffmpeg` on PATH |

An unanswered field expands to an empty string, which the server treats as unset — that case
is what `bundle:verify` exercises, by launching the unpacked bundle with every field empty.

Raw Lua stays unavailable: `DCS_ALLOW_RAW_LUA` is not a bundle setting, and the hook needs
its own `ALLOW_EXEC` as well.

## Live control

Both routes give the live tools, which need the hook in a DCS profile:

```powershell
node dist/index.js install-hook
```

Run that command from the built clone. If you installed only the extension, ask the connected assistant to run `dcs_install_hook` instead. Restart DCS, then `dcs_bridge_status` should report a phase. `dcs_load_mission` swaps a
mission into an **already running** session — it does nothing from the cold menu, so fly any
mission once first. Flying missions and the live bridge are Windows-only; offline authoring
is not.

## What the verification does and does not prove

`npm run bundle:verify` unpacks the built `.mcpb` outside the checkout, checks the manifest
against the MCPB required-field list, expands the same `${__dirname}` and `${user_config.*}`
substitutions Claude Desktop expands, launches the server the way the manifest says to, and
authors, validates, saves and reopens a mission through it. `tests/claude-desktop.test.ts`
covers the config merge, including the cases above that must change nothing.

Neither one installs anything in Claude Desktop. **That the app accepts the bundle, renders
the settings prompts and lists the tools has not been verified here**, and neither has the
tool count: the server registers about 200 tools, which is a lot for one client to show, and
no measurement of how Claude Desktop behaves at that number exists in this repository.
