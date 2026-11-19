# Claude Desktop setup

Two ways to give the Claude Desktop app the DCS tools. Both run the same stdio server
locally: nothing about a mission leaves the machine, and DCS can stay closed while you
author or inspect one.

| | One command | One click |
|---|---|---|
| What you run | `dcs-mcp-server install-claude-desktop` | a built `dcs-mcp-<version>.mcpb` |
| Where the server comes from | the published npm package, or this checkout | packed inside the extension |
| Needs Node.js on the machine | yes | no — Claude Desktop ships its own |
| Needs internet at first start | yes (`--published`) | no |
| Updates | `npx -y dcs-mcp-server@latest …` again | build and install a new `.mcpb` |

## One command: merge an entry into claude_desktop_config.json

```powershell
npx -y dcs-mcp-server install-claude-desktop --published
```

| Flag | Effect |
|---|---|
| `--published` | `npx -y dcs-mcp-server`, wrapped in `cmd /c` on Windows |
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
`$XDG_CONFIG_HOME/Claude/…` (else `~/.config/Claude/…`) elsewhere. With no mode flag it
uses `--local` when this install has a usable `dist/index.js`, otherwise `--published`.

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

On Windows the entry is `cmd /c npx -y dcs-mcp-server`, not `npx …`. Claude Desktop spawns
the command without a shell, and `npx` on Windows is `npx.cmd`, so the bare form fails with
ENOENT and the app reports only that the server did not start.

## One click: an MCPB extension

```powershell
npm ci
npm run bundle:build     # writes dcs-mcp-<version>.mcpb in the repository root
npm run bundle:verify
```

`bundle:build` compiles this checkout, copies the files the npm package publishes, installs
production dependencies from `package-lock.json` with install scripts disabled, writes
`manifest.json`, and zips the result. Nothing is downloaded when the extension is installed.
Install it by double-clicking the `.mcpb`, or through Claude Desktop's extension settings,
then start a new chat.

The manifest follows the MCPB spec (`manifest_version` `0.3`, server type `node`,
`entry_point` `server/dist/index.js`, `command` `node` with `${__dirname}`), and is generated
from `package.json` by `scripts/claude-bundle-manifest.mjs` so the version cannot drift.
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
npx -y dcs-mcp-server install-hook
```

Restart DCS, then `dcs_bridge_status` should report a phase. `dcs_load_mission` swaps a
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
