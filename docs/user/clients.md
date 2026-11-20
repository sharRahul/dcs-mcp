# Connect your AI app

One DCS-MCP server works with different apps over a local MCP connection. You do not need a separate npm package for each app. DCS can stay closed while you create mission files.

## Install the package

Install Node.js 20+ first. Download the **Others** artifact (also used by Codex) from a successful **Build installable packages** run on [GitHub Actions](https://github.com/sharRahul/dcs-mcp/actions/workflows/packages.yml). Unzip the download to find `dcs-mcp-server-<version>.tgz`.

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

## Codex

Register the installed server, then start a new chat:

```powershell
codex mcp add dcs -- node "F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"
```

The same command works with a built clone's absolute `dist/index.js` path. [Codex MCP documentation](https://developers.openai.com/codex/mcp/).

## Others

Use the **Others** download for any app that supports a local MCP server over stdio. Follow the package installation above, then open your app's MCP settings.

Set the command to the absolute path of Node.js and add the installed server entry as its argument:

```json
{
  "mcpServers": {
    "dcs": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["F:/DCS/dcs-tools/node_modules/dcs-mcp-server/dist/index.js"]
    }
  }
}
```

Replace both paths with the actual locations on your computer. Your app may use a different configuration format; use the same command and argument in its local MCP settings. Restart the connection and open a new chat.

Some apps limit the number of tools or response size. The server's `--tools name1,name2` option can limit discovery to selected tools. Keep session persistence enabled if your app starts a new server process for each request.

The server must run on the computer that owns the mission files and optional DCS connection. An app that only supports remote HTTP MCP connections needs a separate transport setup.

## Check any connection

Ask your app:

> List the DCS tools. Create a simple Caucasus training mission with an airborne player F-16. Validate it and save a new .miz file. Tell me the full path.

Use an absolute output path outside the installation folder. Open the saved file in DCS to check flight behavior. For live DCS controls, ask the connected assistant to install the hook using `dcs_install_hook`, or run the installed entry script with `install-hook`, then restart DCS. A smaller tool selection may not include the hook installer.

## What has been verified

`npm run package:verify` installs the built tarball outside the checkout, checks its CLI and resources, tests the Claude config installer against a temporary config, installs the hook into a temporary profile, and creates, validates, saves and reopens a mission over MCP with both the full and starter selections. Plugin and MCPB verification run separately. Client configuration was checked against the linked primary documentation; actual app screens, account access and in-flight behavior are separate checks.
