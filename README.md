# DCS-MCP

**Create and edit DCS World missions by talking to your AI assistant.**

Describe the aircraft, enemies, route and objectives you want. DCS-MCP lets your assistant build a mission and save a `.miz` file you can open in DCS World.

## What can it do?

- Create training and combat missions with aircraft, ships, ground forces and air defences.
- Change routes, weapons, weather, briefings and mission events.
- Inspect an existing mission and save an edited copy.
- Add recorded radio messages and other mission audio.
- Use the included MIST, MOOSE, Skynet-IADS and Splash Damage scripts when requested.
- Check for common mission problems before you fly.
- Optionally connect to a running DCS session for live controls and diagnostics.

DCS can stay closed while you build a mission. You need the appropriate DCS maps and aircraft to fly it.

## Get DCS-MCP

Open the [latest GitHub release](https://github.com/sharRahul/dcs-mcp/releases/latest) and download the file for your app from **Assets**. Extract ZIP downloads first; open the Claude Desktop `.mcpb` directly.

| Your app | What to download | Setup |
| --- | --- | --- |
| Claude Desktop | `dcs-claude-desktop-…` | Open the `.mcpb` extension. [Instructions](docs/user/clients.md#claude-desktop) |
| ChatGPT Desktop | `dcs-chatgpt-plugin-…` | Install the local plugin through a marketplace. [Instructions](docs/user/clients.md#chatgpt-desktop) |
| Codex | `dcs-others-…` | Install the tarball and register the local server. [Instructions](docs/user/clients.md#codex) |
| Others | `dcs-others-…` | Install the npm tarball and add a local MCP server. [Instructions](docs/user/clients.md#others) |

The **Others** download contains the npm file `dcs-mcp-server-<version>.tgz`, also used by Codex. You can install it without an npm account. Node.js 20+ is needed for the npm package; the Claude extension uses Claude Desktop's Node runtime. ChatGPT desktop plugin availability depends on your app and account. These downloads do not create a ChatGPT browser connection.

Distribution is **GitHub-only**. No npm account is needed; use the GitHub download rather than `npx dcs-mcp-server`.

### Prefer to build it yourself?

Install [Node.js 20+](https://nodejs.org/) and [Git](https://git-scm.com/downloads), then run each line in a terminal, stopping if any command fails:

```powershell
git clone https://github.com/sharRahul/dcs-mcp.git
cd dcs-mcp
npm ci
npm run package:build
npm run package:verify
```

This creates and tests the npm tarball locally. The [connection guide](docs/user/clients.md) also explains how to use the built clone directly. Building does not publish anything to npm.

## Try your first mission

After connecting your app, ask:

> Create a simple Caucasus training mission. Put me in an airborne F-16 near Kutaisi, set clear weather and add a short briefing. Check it for problems and save a new .miz file in my DCS Missions folder. Tell me the full file path.

Then ask for changes:

> Add two enemy MiG-29s, give me a wingman and change the time to sunset. Save a new copy.

For an existing mission, give the assistant its full file path and describe what to change.

## Fly the mission

1. Find the `.miz` file at the path your assistant gives you.
2. Open it from DCS World's Missions screen or Mission Editor.
3. Check the briefing, player aircraft and required modules, then fly.

Existing source missions are preserved. Replacing an existing output requires an explicit overwrite. Validation checks the file's structure; test the mission in DCS to confirm its AI, audio and objectives behave as intended.

## Need help?

- **No DCS tools in your chat?** Follow the setup for your app, restart it and open a new chat.
- **DCS is not connected?** File creation still works. Live controls need the optional DCS connection script and a running simulator. [Setup](docs/reference/technical-reference.md#live-bridge-setup)
- **Audio conversion fails?** It needs optional FFmpeg. [Audio setup](docs/user/mission-audio.md)
- **A mission will not open?** Ask your assistant to validate it and check the DCS error log.

[App connection guide](docs/user/clients.md) · [Example scenarios](examples/scenarios/README.md) · [Technical reference](docs/reference/technical-reference.md) · [Tested features and limits](docs/development/verification.md) · [Report a problem](https://github.com/sharRahul/dcs-mcp/issues)

For contributors: [documentation index](docs/README.md), [project scripts](scripts/README.md) and [building and publishing releases](docs/development/releasing.md).

DCS-MCP is licensed under [Apache 2.0](LICENSE) © [github.com/sharRahul](https://github.com/sharRahul). Included community Lua frameworks retain [their own licenses and credits](vendor/lua/README.md).
