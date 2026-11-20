# DCS-MCP local desktop plugin

This package runs the existing DCS MCP server over stdio. It includes the mission-production skill and supports offline mission authoring, inspection and editing. Live tools require the existing DCS bridge and a running simulator.

## Build and verify

Start with a permanent GitHub clone; this does not require the unreleased npm package. Follow the [download and build steps](../../README.md#get-dcs-mcp) first, then from the repository root, with Node 20+ and npm:

```powershell
npm ci
npm run plugin:build
npm run plugin:verify
```

The build cleans `dist/`, compiles this checkout, copies the server's published resources, installs production dependencies from `package-lock.json` with install scripts disabled, and copies `skills/`. It includes local source edits; build from a clean checkout of the intended revision for distribution. Dependency installation may require network access. Generated `server/` and `skills/` are ignored by Git; build before installing or distributing the plugin. The complete `plugins/dcs-chatgpt/` directory is the distributable, and Node must remain available on the desktop app's PATH. No API key or public endpoint is required.

Verification copies the complete plugin to a temporary directory outside the checkout and launches its configured entrypoint there. It checks tool discovery, reference data, aircraft and trigger creation, validation, saving and reopening a `.miz`. It does not start DCS or verify flight behavior.

## Install locally

The repository marketplace is `.agents/plugins/marketplace.json`, named **DCS-MCP Local**. With this repository open in a supported desktop workspace, restart the ChatGPT desktop app, open the Plugins Directory, select that marketplace and install **DCS-MCP**. If needed, register this repository root using `codex plugin marketplace add .`. Start a new chat after installation.

Try: “Use DCS-MCP to create a simple Caucasus mission with an airborne player F-16, validate it and save it to a new absolute path.” Read `dcs://guide/conventions` before authoring. Use the bundled mission-production skill for durable projects and revision evidence.

Local plugins are copied into the host's plugin cache. After code or skill changes, rebuild, refresh/reinstall the local plugin, restart the app and test in a new chat. Do not point the installed package back at repository-relative paths.

Desktop feature availability and account permissions must be checked in the actual ChatGPT client. This package does not establish account eligibility or browser support. If the marketplace is unavailable, record that limitation; successful standalone MCP verification does not prove ChatGPT installed or executed the tools.

The plugin inherits the server's environment configuration (see the root README), with its bridge endpoint set to loopback port 8899. Raw Lua stays disabled unless explicitly enabled in the environment. Request mission output using absolute paths outside the plugin cache. Use offline creation first; loading missions and installing the bridge are separate user-requested actions.

Packaging and installation reference: [OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins).
