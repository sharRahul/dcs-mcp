# Connect your AI app

One DCS-MCP server works with different apps over a local MCP connection. You do not need a separate npm package for each app. DCS can stay closed while you create mission files.

## Install the package

Install Node.js 20+ first. Download the npm artifact from a successful **Build installable packages** run on [GitHub Actions](https://github.com/sharRahul/dcs-mcp/actions/workflows/packages.yml). Unzip the download to find `dcs-mcp-server-<version>.tgz`.

Open a terminal in a permanent folder you want to keep, and run this with the actual tarball path:

```powershell
npm install --prefix ./dcs-tools --ignore-scripts "C:\Downloads\dcs-mcp-server-0.6.4.tgz"
node ./dcs-tools/node_modules/dcs-mcp-server/dist/index.js --version
```

No npm login is needed. npm may download the package's dependencies. Keep `dcs-tools` after setup: your app starts the server from there. To update, install a newer tarball into the same folder and restart the app.

The package and desktop bundles include optional MIST, MOOSE, Skynet-IADS and Splash Damage Lua sources. They are used only when requested, as a fallback to local DCS script installations. [Included versions and upstream notices](../../vendor/lua/README.md).

In the examples below, replace `F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js` with your installed file's **absolute path**. A built GitHub clone's `dist/index.js` works too. Use `(Get-Command node).Source` in PowerShell to find Node's absolute path. Configuration examples must be merged with existing settings, not pasted over them.

## Claude Desktop

For the simplest install, download the Claude Desktop artifact from the same Actions run, unzip it and open its `.mcpb` file in Claude Desktop. Review its settings, install it, restart the app and ask for the DCS tools. This bundle contains its server and dependencies.

For an installed npm tarball, run:

```powershell
node "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js" install-claude-desktop --local
```

The installer records absolute paths, keeps a backup and preserves other app settings. Quit and restart Claude Desktop. See [the full setup guide](claude-desktop.md) for custom folders and extension verification limits.

## ChatGPT Desktop

Use the local desktop plugin, not the npm tarball as a file attachment to a chat. Download the ChatGPT plugin artifact and unzip it into `plugins/dcs-chatgpt/` in your repository clone, replacing its generated bundle. The repository marketplace then points to the complete plugin; follow [local plugin installation](../../plugins/dcs-chatgpt/README.md#install-locally).

OpenAI documents bundled MCP servers and repository marketplaces for local desktop plugins. Availability depends on your app and account. This package does not create a ChatGPT web endpoint or establish account access. [OpenAI packaging documentation](https://developers.openai.com/plugins/build/plugins).

## Cursor

Add this entry to `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "dcs": {
      "type": "stdio",
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"]
    }
  }
}
```

Use the actual Node and server paths on your computer. Reload Cursor's MCP connection, check that `dcs` connects and start a new Agent chat. [Cursor MCP documentation](https://cursor.com/docs/mcp).

## Codex

Register the installed server, then start a new chat:

```powershell
codex mcp add dcs -- node "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"
```

The same command works with a built clone's absolute `dist/index.js` path. [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

## OpenCode

Run this in the project that should use DCS, then inspect the connection:

```powershell
opencode mcp add dcs -- node "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"
opencode mcp list
```

Current OpenCode V2 uses `mcp.servers` in `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "dcs": {
        "type": "local",
        "command": ["node", "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"]
      }
    }
  }
}
```

Older V1 versions used names directly under `mcp`; use the CLI supported by your installed version or its matching schema. [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/).

## Hermes Agent

Add the local command, keeping `--args` last, and test it:

```powershell
hermes mcp add dcs --command node --args "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"
hermes mcp test dcs
```

Alternatively merge into the active profile's `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  dcs:
    command: node
    args:
      - F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js
```

Start a new session or use `/reload-mcp`. `hermes mcp configure dcs` lets you select which DCS tools are exposed. Paths must belong to the machine running Hermes; a Linux/WSL instance needs its own Node installation and Linux paths. [Hermes CLI reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md), [MCP configuration](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).

## Raiker

Raiker's current local connector requires workspace-relative script arguments and limits a response to 200 KB. DCS's full catalogue is about 621 KB, so use the shipped 17-tool starter selection for common mission creation and inspection. This excludes advanced authoring and live-control tools. Do not configure the unrestricted catalogue for this connector.

1. From your **Raiker workspace**, install the tarball with `npm install --prefix ./tools/dcs --ignore-scripts "C:\Downloads\dcs-mcp-server-0.6.4.tgz"`.
2. In Raiker, open **Connections → Advanced → MCP servers**. Review and enable its required MCP runtime permissions. Create its **Developer example**, name it `dcs`, and choose the local Python example. This creates `.raiker/mcp/servers/dcs.py`.
3. Review the shipped launcher, then replace that example file with `tools/dcs/node_modules/dcs-mcp-server/examples/clients/raiker-launcher.py`. This is now custom DCS code, not Raiker's reviewed echo example. It forwards Raiker's bounded request batch to Node, negotiates the shared `2025-06-18` protocol revision, and leaves the server's responses unchanged.
4. Test the `dcs` server. Review the discovered tools and Raiker's **Callable by Raiker** status; respect its permission and tool-review controls. Keep session persistence enabled because this connector starts a fresh process for each operation.

The starter list is in `examples/clients/raiker-tools.json` inside the installed package. Other clients expose all tools unless passed `--tools name1,name2`. This option reduces the catalogue; it is not a filesystem sandbox or a permission grant.

These instructions follow the [Raiker MCP guide](https://github.com/sharRahul/Raiker/blob/main/docs/guide/extensions-and-mcp.md) and [connector implementation](https://github.com/sharRahul/Raiker/blob/main/raiker/runtime/executors/mcp.py). Raiker's host UI and permissions still need an end-to-end app check; package/protocol tests alone do not establish that.

## Check any connection

Ask your app:

> List the DCS tools. Create a simple Caucasus training mission with an airborne player F-16. Validate it and save a new .miz file. Tell me the full path.

Use an absolute output path outside the installation folder. Open the saved file in DCS to check flight behavior. For live DCS controls, ask the connected assistant to install the hook using `dcs_install_hook`, or run the installed entry script with `install-hook`, then restart DCS. The Raiker starter selection does not include the hook installer.

## What has been verified

`npm run package:verify` installs the built tarball outside the checkout, checks its CLI and resources, tests the Claude config installer against a temporary config, installs the hook into a temporary profile, and creates, validates, saves and reopens a mission over MCP with both the full and starter selections. Plugin and MCPB verification run separately. Client configuration was checked against the linked primary documentation; actual app screens, account access and in-flight behavior are separate checks.
