# DCS runtime scripts

These Lua files run inside DCS. They are separate from the tools used to build
and test the MCP server.

- `Hooks/dcs-mcp-hook.lua`: the live-control bridge. The installer copies it to
  your DCS Saved Games `Scripts/Hooks/` folder.
- `dcs-mcp-telemetry.lua`: optional in-mission telemetry.
- `dcs-mcp-e2e-setup.lua`: setup for the example verification mission.
- `Export.lua`: the export-side listener.

Use the [bridge setup instructions](../../docs/reference/technical-reference.md#live-bridge-setup)
before installing scripts. The installed DCS filenames have not changed.
