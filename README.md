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

Open Claude Desktop's MCP configuration file, `claude_desktop_config.json`, and add the following entry. If it already contains other tools, keep those entries too.

```json
{
  "mcpServers": {
    "dcs": {
      "command": "npx",
      "args": ["-y", "dcs-mcp-server"]
    }
  }
}
```

Restart Claude Desktop. The first connection downloads the published DCS-MCP package, so it needs internet access.

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
