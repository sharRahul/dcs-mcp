# DCS-MCP

**Create and edit DCS World missions by talking to your AI assistant.**

Describe the mission you want, and DCS-MCP gives your assistant the tools to build it and save a `.miz` file you can open in DCS World.

## What can I do with it?

- Create missions with aircraft, ground forces, ships and air defences.
- Change routes, weapons, weather, briefings and mission events.
- Inspect an existing mission and save an edited copy.
- Add recorded radio messages and other mission audio.
- Check missions for common problems before you fly.
- Connect to a running DCS session for optional live controls and diagnostics.

DCS can stay closed while you create or edit a mission. You need DCS and the appropriate maps and aircraft to fly it.

## What do I need?

- **An AI app that supports MCP**, such as Claude Desktop or Codex. MCP is the connection that lets the assistant use this tool.
- **[Node.js](https://nodejs.org/) version 20 or newer**, installed on the computer running DCS-MCP.
- **DCS World on Windows** for flying missions and using live controls.

Local ChatGPT Desktop plugin setup is also available. Support depends on your desktop app and account; browser access is not included in this setup.

## Set it up once

### Claude Desktop

Pick one of these. Both end with the same DCS tools in your chats.

**One command (published package).** Run this in a terminal, then quit Claude Desktop completely and start it again:

```powershell
npx -y dcs-mcp-server install-claude-desktop --published
```

It adds a `dcs` entry to `claude_desktop_config.json` and leaves everything else in that file alone, keeping a timestamped backup of the previous version. Add `--saved-games "C:\Users\<you>\Saved Games\DCS"` if DCS uses a profile folder other than `Saved Games\DCS` or `DCS.openbeta`. Use `--dry-run` to see what it would write, and `--force` to replace a `dcs` entry you already have. The first start downloads the published package, so it needs internet access.

**One click (extension file).** Build a `.mcpb` extension from a clone and double-click it; Claude Desktop installs it, asks for your DCS folders and needs no Node.js of its own:

```powershell
npm ci; npm run bundle:build; npm run bundle:verify
```

That writes `dcs-mcp-<version>.mcpb` in the repository root. See [Claude Desktop setup](docs/claude-desktop.md) for the details and what the build does not prove.

**By hand.** Open `claude_desktop_config.json` yourself and add the entry below, keeping any other tools already in the file. On Windows the `cmd /c` wrapper matters: Claude Desktop starts the command without a shell, so a bare `npx` is not found.

```json
{
  "mcpServers": {
    "dcs": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "dcs-mcp-server"]
    }
  }
}
```

On macOS and Linux use `"command": "npx"` with `"args": ["-y", "dcs-mcp-server"]`. Restart Claude Desktop afterwards.

### Codex

Run this once in a terminal, then start a new chat:

```powershell
codex mcp add dcs -- npx -y dcs-mcp-server
```

### ChatGPT Desktop or a copy downloaded from GitHub

The GitHub version needs a build step before use. Follow the [local plugin setup](plugins/dcs-chatgpt/README.md) for ChatGPT Desktop, or the [connection instructions](docs/technical-reference.md#client-configuration) for other apps. These instructions use the code in this repository; the options above use the published package.

## Create your first mission

Once connected, ask your assistant:

> Create a simple Caucasus training mission. Put me in an airborne F-16 near Kutaisi, set clear weather and add a short briefing. Check the mission for problems and save it as a new .miz file in my DCS Missions folder. Tell me the full file path.

You can then ask for changes:

> Add two enemy MiG-29s, give me a wingman and change the time to sunset. Save a new copy.

To edit a mission you already have:

> Open the mission at this file path, explain what is in it, and make the enemy defences easier. Keep the original and save an edited copy.

Give the assistant the full path to an existing mission. Missions normally live in `Saved Games\DCS\Missions` under your Windows user folder.

## Open and fly the mission

1. Find the `.miz` file at the path your assistant gives you.
2. Open DCS World and select the file from the Missions screen, or open it in the Mission Editor.
3. Check the briefing, player aircraft and required modules before flying.

DCS-MCP checks the mission's structure, but a successful check does not guarantee that every AI action, radio message or objective works in flight. Test your mission in DCS before sharing it.

## Optional: connect to a running DCS session

You only need this for live controls. Run:

```powershell
npx -y dcs-mcp-server install-hook
```

Restart DCS, then ask: “Is DCS connected?” The installer adds the connection script to your DCS Saved Games folder. See [live connection setup](docs/technical-reference.md#live-bridge-setup) if your installation uses a different folder.

## If something does not work

- **The assistant cannot see DCS tools:** restart the AI app and start a new chat. Check that Node.js is installed and the connection settings were saved.
- **DCS is not connected:** you can still create and edit mission files. Live controls need the connection script and a running DCS instance.
- **A mission will not open or behaves unexpectedly:** ask the assistant to validate the file and check the DCS error log.
- **Audio conversion fails:** it needs the optional FFmpeg program. See [mission audio setup](docs/mission-audio.md).

Editing an existing mission preserves its source file. Saving refuses to replace an existing destination unless you explicitly request an overwrite.

## More help

- [Technical reference and complete tool list](docs/technical-reference.md)
- [Example mission scenarios](examples/scenarios/README.md)
- [What has been tested and known limits](docs/verification.md)
- [Developer scripts: what the .mjs files do](scripts/README.md)
- [Report a problem](https://github.com/sharRahul/dcs-mcp/issues)

Licensed under [Apache 2.0](LICENSE).
